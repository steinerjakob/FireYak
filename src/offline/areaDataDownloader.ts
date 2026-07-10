import { GeoBounds } from '@/types/geo';
import { fetchAreaRaw } from '@/mapHandler/overPassApi';
import { storeMapNodes } from '@/mapHandler/databaseHandler';
import { reconcileDeletedNodes } from '@/mapHandler/markerHandler';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Chunk edge length in degrees. Kept under the 0.5°/axis clamp that
 * `buildAreaQuery` applies, so no chunk is ever silently shrunk, and small
 * enough to stay well inside Overpass' server timeout and 2000-element limit.
 */
const CHUNK_STEP_DEGREES = 0.25;
/** Extra attempts per chunk after the first try fails (2 → up to 3 tries). */
const CHUNK_RETRIES = 2;
/** Polite pause between chunks so a large district doesn't hammer Overpass. */
const CHUNK_SLEEP_MS = 1000;
/** Overpass truncates an area query at this many elements. */
const OVERPASS_TRUNCATION_LIMIT = 2000;

/**
 * Splits `bounds` into a grid of `step`-degree chunks (last row/column clamped
 * to the outer edge). Non-overlapping, so a node lands in exactly one chunk.
 */
export function* chunkBounds(bounds: GeoBounds, step = CHUNK_STEP_DEGREES): Generator<GeoBounds> {
	for (let south = bounds.south; south < bounds.north; south += step) {
		for (let west = bounds.west; west < bounds.east; west += step) {
			yield {
				south,
				west,
				north: Math.min(south + step, bounds.north),
				east: Math.min(west + step, bounds.east)
			};
		}
	}
}

/** Number of chunks an area's bounds decompose into (for progress totals). */
export function countChunks(bounds: GeoBounds): number {
	let count = 0;
	for (const _ of chunkBounds(bounds)) count++;
	return count;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying up to `attempts` extra times on failure. Aborts short-
 * circuit immediately — a cancelled download must not keep retrying.
 */
async function retry<T>(fn: () => Promise<T>, attempts: number, signal: AbortSignal): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i <= attempts; i++) {
		if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (signal.aborted) throw error;
		}
	}
	throw lastError;
}

export interface AreaDownloadProgress {
	/** Index of the chunk just completed (resume point). */
	lastCompletedChunk: number;
	/** Chunks finished so far. */
	done: number;
	/** Total chunks in the area. */
	total: number;
	/** Running count of distinct nodes stored for the area. */
	nodeCount: number;
}

export interface DownloadAreaOptions {
	/** Bounds of the area to download. */
	bounds: GeoBounds;
	/** Resume point from a previous run (−1 when starting fresh). */
	lastCompletedChunk: number;
	/** Node count carried over from a previous partial run (0 on fresh/refresh). */
	baseNodeCount: number;
	/**
	 * Refresh mode: iterate every chunk from the start and reconcile deletions
	 * per chunk (nodes gone from OSM are removed from the cache).
	 */
	refresh: boolean;
	/** Persisted after every completed chunk (DB write + reactive update). */
	onProgress: (progress: AreaDownloadProgress) => void | Promise<void>;
}

/**
 * Downloads all water-source data for an area, chunk by chunk, resuming at
 * `lastCompletedChunk + 1`. Each chunk is stored immediately so progress is
 * durable if the app is killed mid-download. On `refresh`, deletions are
 * reconciled per chunk (guarded against the truncation limit).
 *
 * Throws `AbortError` when cancelled and re-throws the last chunk error when a
 * chunk fails after all retries — the caller marks the area `error` and can
 * resume later from the persisted `lastCompletedChunk`.
 */
export async function downloadAreaData(
	options: DownloadAreaOptions,
	signal: AbortSignal
): Promise<void> {
	const chunks = [...chunkBounds(options.bounds)];
	const total = chunks.length;
	const start = options.refresh ? 0 : options.lastCompletedChunk + 1;
	const baseNodeCount = options.refresh ? 0 : options.baseNodeCount;

	// Distinct node ids seen during this run; chunks don't overlap, so this is an
	// accurate delta on top of `baseNodeCount`.
	const seenIds = new Set<number>();

	for (let i = start; i < total; i++) {
		const elements = await retry(() => fetchAreaRaw(chunks[i], signal), CHUNK_RETRIES, signal);

		await storeMapNodes(elements);

		// Only reconcile deletions when the chunk was not truncated, otherwise
		// cut-off nodes would be wrongly hard-deleted.
		if (options.refresh && elements.length < OVERPASS_TRUNCATION_LIMIT) {
			await reconcileDeletedNodes(chunks[i], elements);
		}

		for (const element of elements) seenIds.add(element.id);

		await options.onProgress({
			lastCompletedChunk: i,
			done: i + 1,
			total,
			nodeCount: baseNodeCount + seenIds.size
		});

		if (i < total - 1) await sleep(CHUNK_SLEEP_MS);
	}
}
