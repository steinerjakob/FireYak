import { defineStore } from 'pinia';
import { ref } from 'vue';
import { GeoBounds } from '@/types/geo';
import {
	OfflineArea,
	getAllOfflineAreas,
	addOfflineArea,
	updateOfflineArea,
	deleteOfflineArea
} from '@/mapHandler/databaseHandler';
import { countChunks, downloadAreaData } from '@/offline/areaDataDownloader';
import { downloadTiles, downloadStyleAssets } from '@/offline/tileDownloader';
import { tileStore } from '@/offline/tileStore';
import {
	tileCount,
	PROTOMAPS_MAX_ZOOM,
	SATELLITE_MAX_ZOOM,
	TERRAIN_MAX_ZOOM
} from '@/offline/tileMath';
import { invalidateDownloadedAreasCache } from '@/offline/offlineProtocol';
import { useNetworkStatus } from '@/composable/networkStatus';

/**
 * Largest area we accept, per axis (degrees). Districts can span several chunks,
 * so this is not a chunking limit — it is a guard rail against someone selecting
 * a whole country and firing hundreds of Overpass requests. ~1° ≈ 111 km.
 */
export const MAX_AREA_SPAN_DEGREES = 1.0;

/** An area is auto-refreshed once it is older than this (opt-in, Wi-Fi only). */
const AUTO_REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Per-area abort controllers for in-flight downloads. Kept outside the reactive
 * state (AbortController isn't serialisable and must not be proxied) and at
 * module scope so downloads survive component unmount / navigation.
 */
const controllers = new Map<number, AbortController>();

/** `navigator.storage.persist()` is requested once, before the first download. */
let persistRequested = false;
async function requestPersistentStorage(): Promise<void> {
	if (persistRequested) return;
	persistRequested = true;
	try {
		if (navigator.storage?.persist && !(await navigator.storage.persisted?.())) {
			// Fire-and-forget: opt out of best-effort eviction on the web so a
			// downloaded district isn't silently reclaimed under storage pressure.
			await navigator.storage.persist();
		}
	} catch {
		// Not fatal — the download proceeds regardless.
	}
}

/** True if the bounds exceed {@link MAX_AREA_SPAN_DEGREES} on either axis. */
export function isAreaTooLarge(bounds: GeoBounds): boolean {
	return (
		bounds.north - bounds.south > MAX_AREA_SPAN_DEGREES ||
		bounds.east - bounds.west > MAX_AREA_SPAN_DEGREES
	);
}

/** One tile source to download for an area, with its max zoom. */
interface TileJob {
	source: string;
	zMax: number;
}

/** The tile sources an area needs: protomaps always, satellite/terrain per toggles. */
function tileJobsFor(area: OfflineArea): TileJob[] {
	const jobs: TileJob[] = [{ source: 'protomaps', zMax: PROTOMAPS_MAX_ZOOM }];
	if (area.includeSatellite) jobs.push({ source: 'satellite', zMax: SATELLITE_MAX_ZOOM });
	if (area.includeTerrain) jobs.push({ source: 'terrain', zMax: TERRAIN_MAX_ZOOM });
	return jobs;
}

/** Total tiles across all of the area's enabled sources (for the progress total). */
function totalTilesFor(area: OfflineArea): number {
	return tileJobsFor(area).reduce((sum, job) => sum + tileCount(area.bounds, 0, job.zMax), 0);
}

export interface CreateAreaInput {
	name: string;
	bounds: GeoBounds;
	includeSatellite: boolean;
	includeTerrain: boolean;
	autoRefreshOnWifi: boolean;
}

/** The two phases of an area download, used only for progress UX. */
export type DownloadPhase = 'data' | 'tiles';

export const useOfflineAreasStore = defineStore('offlineAreas', () => {
	const areas = ref<OfflineArea[]>([]);
	let initialized = false;

	/**
	 * Transient per-area download phase (not persisted). The data phase is a
	 * handful of slow Overpass calls with no incremental progress, while the
	 * tile phase ticks thousands of times — the UI renders them differently
	 * (indeterminate bar + chunk counter vs. determinate bar + percent).
	 */
	const phases = ref<Record<number, DownloadPhase>>({});

	/** Current download phase for the area, or `undefined` when idle. */
	function phaseOf(id: number | undefined): DownloadPhase | undefined {
		return id != null ? phases.value[id] : undefined;
	}

	/** Replaces the reactive record for `id` with a patched copy. */
	function patchLocal(id: number, patch: Partial<OfflineArea>): void {
		const index = areas.value.findIndex((area) => area.id === id);
		if (index !== -1) {
			areas.value[index] = { ...areas.value[index], ...patch };
		}
	}

	/** Persists a patch to IndexedDB and mirrors it into reactive state. */
	async function persist(id: number, patch: Partial<OfflineArea>): Promise<void> {
		patchLocal(id, patch);
		await updateOfflineArea(id, patch);
	}

	/**
	 * Loads areas from the DB. Any area left in a transient `downloading`/
	 * `refreshing` state belongs to a previous session that was killed mid-run —
	 * mark it `error` so the user gets a Retry action (which resumes, not
	 * restarts). Also runs the Wi-Fi auto-refresh check.
	 */
	async function init(): Promise<void> {
		if (initialized) return;
		initialized = true;

		const stored = await getAllOfflineAreas();
		areas.value = stored;

		for (const area of stored) {
			if (area.id != null && (area.status === 'downloading' || area.status === 'refreshing')) {
				await persist(area.id, { status: 'error' });
			}
		}

		void checkAutoRefresh();
	}

	/** Core download loop shared by create / retry / refresh. */
	async function runDownload(id: number, refresh: boolean): Promise<void> {
		const area = areas.value.find((a) => a.id === id);
		if (!area || area.id == null) return;
		// Guard against a double-start (e.g. rapid taps).
		if (controllers.has(id)) return;

		await requestPersistentStorage();
		// A new/updated area affects the protocol's write-through gate.
		invalidateDownloadedAreasCache();

		const controller = new AbortController();
		controllers.set(id, controller);
		const signal = controller.signal;

		// Unified progress: data chunks first, then tiles. `total` covers both so a
		// single progress bar spans the whole download.
		const dataTotal = countChunks(area.bounds);
		const combinedTotal = dataTotal + totalTilesFor(area);
		const startChunk = refresh ? -1 : area.lastCompletedChunk;
		const dataDoneAtStart = Math.max(startChunk + 1, 0);

		// Tile-phase resume state. Reset on refresh (re-verify every tile — cheap,
		// has() hits skip re-download); carried over on retry.
		const tileResume: Record<string, number> = refresh ? {} : { ...(area.tileResume ?? {}) };
		// Tiles persist across a refresh, so keep the accumulated size; only genuinely
		// new tiles add to it.
		let sizeBytes = area.sizeBytes;
		let tilesProcessed = Object.values(tileResume).reduce((a, b) => a + b, 0);

		// Persisting per tile would mean thousands of IDB writes; throttle to ~300ms
		// (and force-flush at phase boundaries). Losing <300ms of resume cursor on a
		// crash is harmless — has() re-checks make the redone tiles free.
		let lastFlush = 0;
		async function flushTileProgress(force: boolean): Promise<void> {
			const now = Date.now();
			if (!force && now - lastFlush < 300) return;
			lastFlush = now;
			await persist(id, {
				progress: { done: dataDoneAtStart + tilesProcessed, total: combinedTotal },
				tileCount: tilesProcessed,
				sizeBytes,
				tileResume: { ...tileResume }
			});
		}

		await persist(id, {
			status: refresh ? 'refreshing' : 'downloading',
			lastCompletedChunk: startChunk,
			progress: { done: dataDoneAtStart + tilesProcessed, total: combinedTotal }
		});

		try {
			// --- Phase 1: water-source data ---
			phases.value[id] = 'data';
			await downloadAreaData(
				{
					bounds: area.bounds,
					lastCompletedChunk: startChunk,
					baseNodeCount: area.nodeCount,
					refresh,
					onProgress: (progress) =>
						persist(id, {
							lastCompletedChunk: progress.lastCompletedChunk,
							// Offset by tiles already done so the bar never goes backwards.
							progress: { done: progress.done + tilesProcessed, total: combinedTotal },
							nodeCount: progress.nodeCount
						})
				},
				signal
			);

			// --- Phase 2: map tiles + style assets ---
			// Assets first (small, idempotent) so labels/icons render as soon as the
			// tiles arrive.
			phases.value[id] = 'tiles';
			await downloadStyleAssets(signal);

			const currentArea = areas.value.find((a) => a.id === id) ?? area;
			for (const job of tileJobsFor(currentArea)) {
				await downloadTiles({
					bounds: currentArea.bounds,
					source: job.source,
					zMax: job.zMax,
					areaId: id,
					signal,
					resumeFrom: tileResume[job.source] ?? 0,
					onProgress: async ({ processed, bytesAdded }) => {
						const prev = tileResume[job.source] ?? 0;
						tilesProcessed += processed - prev;
						tileResume[job.source] = processed;
						sizeBytes += bytesAdded;
						await flushTileProgress(false);
					}
				});
				await flushTileProgress(true);
			}

			await persist(id, {
				status: 'ready',
				lastRefreshedAt: Date.now(),
				tileCount: tilesProcessed,
				sizeBytes,
				progress: { done: combinedTotal, total: combinedTotal }
			});
		} catch (error) {
			// Both a user cancel (aborted signal) and a genuine failure leave the
			// area `error`/incomplete: its persisted `lastCompletedChunk` is the
			// resume point, and the UI offers "Resume download". removeArea's abort
			// is a no-op here since the record is deleted concurrently.
			if (!controller.signal.aborted) {
				console.error('Offline area download failed:', error);
			}
			await persist(id, { status: 'error' });
		} finally {
			delete phases.value[id];
			if (controllers.get(id) === controller) {
				controllers.delete(id);
			}
		}
	}

	/** Creates a new area record and immediately starts its download. */
	async function createArea(input: CreateAreaInput): Promise<number> {
		const record: OfflineArea = {
			name: input.name,
			bounds: input.bounds,
			createdAt: Date.now(),
			lastRefreshedAt: null,
			includeSatellite: input.includeSatellite,
			includeTerrain: input.includeTerrain,
			autoRefreshOnWifi: input.autoRefreshOnWifi,
			nodeCount: 0,
			tileCount: 0,
			sizeBytes: 0,
			status: 'downloading',
			progress: { done: 0, total: countChunks(input.bounds) },
			lastCompletedChunk: -1
		};

		const id = await addOfflineArea(record);
		areas.value.push({ ...record, id });
		void runDownload(id, false);
		return id;
	}

	/** Resumes a failed/partial download at the last completed chunk + 1. */
	async function retryArea(id: number): Promise<void> {
		await runDownload(id, false);
	}

	/** Re-downloads the whole area from scratch, reconciling OSM deletions. */
	async function refreshArea(id: number): Promise<void> {
		await runDownload(id, true);
	}

	/** Aborts an in-flight download (progress stays persisted for resume). */
	function cancelDownload(id: number): void {
		controllers.get(id)?.abort();
	}

	/** Renames an area. */
	async function renameArea(id: number, name: string): Promise<void> {
		await persist(id, { name });
	}

	/**
	 * Deletes an area: aborts any running download, removes the record, and
	 * drops it from reactive state. Cached nodes are intentionally left — once
	 * the area is gone they are no longer protected and pruning reclaims them.
	 */
	async function removeArea(id: number): Promise<void> {
		cancelDownload(id);
		controllers.delete(id);
		// Drop this area's tile references; tiles unreferenced afterwards are freed
		// (tiles shared with another overlapping area survive).
		await tileStore.deleteArea(id);
		await deleteOfflineArea(id);
		areas.value = areas.value.filter((area) => area.id !== id);
		invalidateDownloadedAreasCache();
	}

	/**
	 * Auto-refreshes opted-in areas older than 30 days when on Wi-Fi. On native
	 * we require `connectionType === 'wifi'`; on the web `connectionType` is
	 * usually `'unknown'`, so any online connection is accepted (the browser
	 * cannot distinguish Wi-Fi from cellular).
	 */
	async function checkAutoRefresh(): Promise<void> {
		const { isOnline, connectionType } = useNetworkStatus();
		if (!isOnline.value) return;
		const onWifi = connectionType.value === 'wifi' || connectionType.value === 'unknown';
		if (!onWifi) return;

		const now = Date.now();
		for (const area of areas.value) {
			if (
				area.id != null &&
				area.autoRefreshOnWifi &&
				area.status === 'ready' &&
				area.lastRefreshedAt != null &&
				now - area.lastRefreshedAt > AUTO_REFRESH_MAX_AGE_MS
			) {
				void refreshArea(area.id);
			}
		}
	}

	/** True while a download/refresh for the area is in flight. */
	function isDownloading(id: number): boolean {
		return controllers.has(id);
	}

	return {
		areas,
		phaseOf,
		init,
		createArea,
		retryArea,
		refreshArea,
		cancelDownload,
		renameArea,
		removeArea,
		checkAutoRefresh,
		isDownloading
	};
});
