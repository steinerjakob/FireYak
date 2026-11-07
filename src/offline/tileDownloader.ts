import { GeoBounds } from '@/types/geo';
import { tileStore } from '@/offline/tileStore';
import { tilesForBounds } from '@/offline/tileMath';
import { NETWORK_URL } from '@/offline/offlineProtocol';

/** Parallel tile fetches per source. Kept modest to stay polite to the CDNs. */
const CONCURRENCY = 6;
/**
 * Extra attempts after the first failure. With the capped exponential backoff
 * below this is roughly 5 minutes of waiting per tile, enough to ride out a
 * typical per-minute rate-limit window instead of failing the whole download.
 */
const MAX_RETRIES = 10;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/** Permanent HTTP failure: retrying won't help (e.g. 404, 403 bad key). */
class PermanentHttpError extends Error {}

const abortError = () => new DOMException('Download aborted', 'AbortError');

/** setTimeout that rejects right away when the download is paused/cancelled. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(abortError());
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Per-host "do not send before" timestamp. When one worker is rate limited,
 * every worker hitting that host backs off together instead of the other five
 * continuing to hammer it (which only extends the throttle).
 */
const hostCooldownUntil = new Map<string, number>();

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds. Note it
 * is only readable cross-origin if the server exposes it via CORS; otherwise we
 * fall back to our own backoff.
 */
function retryAfterMs(resp: Response): number | null {
	const header = resp.headers.get('Retry-After');
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(header);
	return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Exponential backoff with ±25% jitter so workers don't retry in lockstep. */
function backoffMs(attempt: number): number {
	const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
	return base * (0.75 + Math.random() * 0.5);
}

/**
 * Fetches `url`, retrying on 429/5xx and network errors with capped
 * exponential backoff (honouring `Retry-After` when present). A 429 or 5xx
 * puts the whole host into a shared cooldown. Aborts short-circuit immediately,
 * including mid-wait (pause/cancel from the UI). Rethrows the last error after
 * the retry budget is spent so the caller can mark the area `error` and resume
 * later.
 */
async function fetchWithBackoff(url: string, signal: AbortSignal): Promise<Response> {
	const host = hostOf(url);
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		// Respect a cooldown another worker set for this host.
		const waitForHost = (hostCooldownUntil.get(host) ?? 0) - Date.now();
		if (waitForHost > 0) await abortableSleep(waitForHost, signal);
		if (signal.aborted) throw abortError();

		let delay = backoffMs(attempt);
		try {
			const resp = await fetch(url, { signal });
			if (resp.ok) return resp;
			// Retry only transient statuses; 4xx (except 408/429) is permanent.
			if (resp.status !== 429 && resp.status !== 408 && resp.status < 500) {
				throw new PermanentHttpError(`Tile HTTP ${resp.status}`);
			}
			lastError = new Error(`Tile HTTP ${resp.status}`);
			const hinted = retryAfterMs(resp);
			if (hinted != null) delay = Math.min(Math.max(delay, hinted), 5 * MAX_BACKOFF_MS);
			// Throttle every worker on this host, not just this one.
			hostCooldownUntil.set(host, Math.max(hostCooldownUntil.get(host) ?? 0, Date.now() + delay));
		} catch (err) {
			if (signal.aborted || err instanceof PermanentHttpError) throw err;
			// Network error. In browsers a 429 without CORS headers also lands here.
			lastError = err;
		}
		if (attempt < MAX_RETRIES) {
			await abortableSleep(delay, signal);
		}
	}
	throw lastError;
}

export interface TileProgress {
	/** Tiles processed for this source so far (the resume cursor). */
	processed: number;
	/** Bytes newly written by the tile just handled (0 for ref-only overlaps). */
	bytesAdded: number;
}

export interface DownloadTilesOptions {
	bounds: GeoBounds;
	/** Source key into {@link NETWORK_URL} (`protomaps` | `satellite` | `terrain`). */
	source: string;
	/** Inclusive max zoom to download (min is always 0). */
	zMax: number;
	areaId: number;
	signal: AbortSignal;
	/**
	 * Tiles already processed in a previous (interrupted) run for this source.
	 * The iterator order is deterministic, so skipping this many resumes exactly
	 * where we left off; any already-stored tile is a cheap `has()` hit anyway.
	 */
	resumeFrom?: number;
	/** Called after every processed tile (persist resume cursor + size). */
	onProgress: (p: TileProgress) => void | Promise<void>;
}

/**
 * Downloads every tile of one source covering the area, using a worker pool over
 * a single shared iterator (single-threaded JS makes the shared cursor safe).
 * Tiles already present get a reference to this area instead of being refetched,
 * so overlapping areas are nearly free.
 */
export async function downloadTiles(opts: DownloadTilesOptions): Promise<void> {
	const { bounds, source, zMax, areaId, signal, onProgress } = opts;
	const it = tilesForBounds(bounds, 0, zMax)[Symbol.iterator]();

	// Fast-forward the shared iterator past tiles handled in a previous run.
	for (let skipped = 0; skipped < (opts.resumeFrom ?? 0); skipped++) {
		if (it.next().done) return;
	}

	let processed = opts.resumeFrom ?? 0;
	const build = NETWORK_URL[source];

	const worker = async () => {
		for (let r = it.next(); !r.done; r = it.next()) {
			if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
			const { z, x, y } = r.value;

			let bytesAdded = 0;
			if (await tileStore.has(source, z, x, y)) {
				// Overlap with an already-downloaded tile: reference only.
				await tileStore.addAreaRef(source, z, x, y, areaId);
			} else {
				const resp = await fetchWithBackoff(build(z, x, y), signal);
				const blob = await resp.blob();
				await tileStore.put(source, z, x, y, blob, { areaId });
				bytesAdded = blob.size;
			}

			processed += 1;
			await onProgress({ processed, bytesAdded });
		}
	};

	await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

// ---------------------------------------------------------------------------
// Style assets (glyphs + sprites)
// ---------------------------------------------------------------------------

/**
 * Fonts used by the Protomaps basemap layers (see `@protomaps/basemaps`). The
 * app never renders non-Latin scripts of its own, so we prefetch the Latin
 * ranges only.
 *
 * Ranges: `0-255` already covers Basic Latin + Latin-1 Supplement, i.e. every
 * German umlaut (ä ö ü ß, U+00DF–U+00FC, all < 256). `256-511` (Latin Extended-A)
 * is prefetched too for safety on place names with e.g. Central-European
 * diacritics — cheap insurance, a handful of extra pbf files.
 */
const GLYPH_FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const GLYPH_RANGES = ['0-255', '256-511'];
/** Sprite flavors referenced by MainMap's style (`sprites/v4/{light,dark}`). */
const SPRITE_FLAVORS = ['light', 'dark'];

/** Asset request paths (relative to the assets protocol base) that the style needs. */
function styleAssetPaths(): string[] {
	const paths: string[] = [];
	for (const font of GLYPH_FONTS) {
		for (const range of GLYPH_RANGES) {
			// {fontstack} is percent-encoded by MapLibre; mirror that so the cache
			// key matches the URL the protocol will later be asked for.
			paths.push(`fonts/${encodeURIComponent(font)}/${range}.pbf`);
		}
	}
	for (const flavor of SPRITE_FLAVORS) {
		// MapLibre requests both pixel ratios and both json/png per flavor.
		paths.push(
			`sprites/v4/${flavor}.json`,
			`sprites/v4/${flavor}.png`,
			`sprites/v4/${flavor}@2x.json`,
			`sprites/v4/${flavor}@2x.png`
		);
	}
	return paths;
}

const ASSET_BASE = 'https://protomaps.github.io/basemaps-assets/';

/**
 * Prefetches the style's glyphs and sprites into the tile store so labels and
 * POI icons render offline. Idempotent: already-cached assets are skipped, so it
 * is nearly free to re-run on a resume/refresh. Missing individual assets are
 * tolerated (a font range that 404s just means those glyphs render as boxes).
 */
export async function downloadStyleAssets(signal: AbortSignal): Promise<void> {
	for (const path of styleAssetPaths()) {
		if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
		if (await tileStore.getAsset(path)) continue;
		try {
			const resp = await fetchWithBackoff(ASSET_BASE + path, signal);
			await tileStore.putAsset(path, await resp.blob());
		} catch (err) {
			if (signal.aborted) throw err;
			// Non-fatal: keep going so one missing range doesn't fail the download.
			console.warn('Failed to prefetch style asset', path, err);
		}
	}
}
