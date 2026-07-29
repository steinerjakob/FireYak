import { GeoBounds } from '@/types/geo';
import { fetchWaterSources, getExtractTimestampMs } from '@/mapHandler/staticDataApi';
import { storeMapNodes } from '@/mapHandler/databaseHandler';
import { reconcileDeletedNodes } from '@/mapHandler/markerHandler';
import { toRef } from '@/helper/osmRef';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Extra attempts after the first try fails (2 → up to 3 tries total). */
const READ_RETRIES = 2;

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
	/** `true` once the single data read has completed and been stored. */
	dataDone: boolean;
	/** Distinct node count stored for the area (only meaningful once `dataDone`). */
	nodeCount: number;
}

export interface DownloadAreaOptions {
	/** Bounds of the area to download. */
	bounds: GeoBounds;
	/**
	 * `true` when a previous run already completed the data phase for this area
	 * — skips the read entirely so a resumed download doesn't re-fetch data it
	 * already has. Ignored when `refresh` is set: a refresh always re-reads, both
	 * to pick up new data and to reconcile deletions.
	 */
	alreadyDownloaded: boolean;
	/**
	 * Refresh mode: re-read the whole area even if already downloaded, and
	 * reconcile deletions against the fresh result (guarded by the extract's
	 * staleness — see {@link reconcileDeletedNodes}).
	 */
	refresh: boolean;
	/** Called once the data phase finishes (or is skipped as already-done). */
	onProgress: (progress: AreaDownloadProgress) => void | Promise<void>;
}

/**
 * Downloads all water-source data for an area via a single FlatGeobuf bbox
 * range read (§4.6 of `plans/selfhost-osm-data.md`) — no chunking, no
 * rate-limit pacing, and no truncation guard, since a range read is never
 * truncated the way Overpass's 2000-element response could be.
 *
 * On `refresh`, deletions are reconciled against the extract's planet
 * timestamp: a cached node absent from the read is hard-deleted only if it was
 * learned about *before* the extract was cut, so a marker the user just added
 * through the app (or any other post-cut change) survives. If the timestamp
 * can't be determined, reconciliation is skipped entirely for this run.
 *
 * Throws `AbortError` when cancelled, and re-throws the read's error when it
 * fails after all retries — the caller marks the area `error` and can resume
 * later (the persisted "already downloaded" flag makes a resume a no-op for
 * the data phase if the read had actually succeeded before the failure).
 */
export async function downloadAreaData(
	options: DownloadAreaOptions,
	signal: AbortSignal
): Promise<void> {
	if (options.alreadyDownloaded && !options.refresh) return;

	if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');

	// The signal goes into the read itself, not just around it: a cancel has to
	// abort the range requests in flight, not wait for them to finish.
	const elements = await retry(
		() => fetchWaterSources(options.bounds, signal),
		READ_RETRIES,
		signal
	);

	if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');

	await storeMapNodes(elements);

	if (options.refresh) {
		const sourceTimestampMs = await getExtractTimestampMs();
		if (sourceTimestampMs !== null) {
			await reconcileDeletedNodes(options.bounds, elements, sourceTimestampMs);
		}
	}

	const distinctRefs = new Set(elements.map((element) => toRef(element.type, element.id)));

	await options.onProgress({ dataDone: true, nodeCount: distinctRefs.size });
}
