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

export const useOfflineAreasStore = defineStore('offlineAreas', () => {
	const areas = ref<OfflineArea[]>([]);
	let initialized = false;

	/** Replaces the reactive record for `id` with a patched copy. */
	function patchLocal(id: number, patch: Partial<OfflineArea>): void {
		const index = areas.value.findIndex((area) => area.id === id);
		if (index !== -1) {
			areas.value[index] = { ...areas.value[index], ...patch };
		}
	}

	/**
	 * Per-area chain that serialises IndexedDB writes. `updateOfflineArea` is a
	 * non-atomic read-modify-write, so the parallel data and tile phases (which
	 * both persist progress) would otherwise interleave and clobber each other's
	 * fields. Chaining keeps every write applied on top of the previous one.
	 */
	const persistChains = new Map<number, Promise<void>>();

	/** Persists a patch to IndexedDB and mirrors it into reactive state. */
	async function persist(id: number, patch: Partial<OfflineArea>): Promise<void> {
		// Reactive mirror is synchronous and always reflects the latest patch.
		patchLocal(id, patch);
		const prev = persistChains.get(id) ?? Promise.resolve();
		// updateOfflineArea swallows its own errors, so the chain never rejects.
		const next = prev.then(() => updateOfflineArea(id, patch));
		persistChains.set(id, next);
		void next.finally(() => {
			if (persistChains.get(id) === next) persistChains.delete(id);
		});
		await next;
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

		// Unified progress: Overpass data chunks + tiles run in parallel and both
		// count toward one bar. `total` covers both; `dataDone`/`tilesProcessed`
		// are the live per-source tallies summed into the persisted `done`.
		const dataTotal = countChunks(area.bounds);
		const combinedTotal = dataTotal + totalTilesFor(area);
		const startChunk = refresh ? -1 : area.lastCompletedChunk;
		let dataDone = Math.max(startChunk + 1, 0);

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
				progress: { done: dataDone + tilesProcessed, total: combinedTotal },
				tileCount: tilesProcessed,
				sizeBytes,
				tileResume: { ...tileResume }
			});
		}

		await persist(id, {
			status: refresh ? 'refreshing' : 'downloading',
			lastCompletedChunk: startChunk,
			progress: { done: dataDone + tilesProcessed, total: combinedTotal }
		});

		// Overpass data and tiles download concurrently: the Overpass timeout/retry
		// handling overlaps with productive tile downloading instead of blocking it.
		const dataTask = downloadAreaData(
			{
				bounds: area.bounds,
				lastCompletedChunk: startChunk,
				baseNodeCount: area.nodeCount,
				refresh,
				onProgress: (progress) => {
					dataDone = progress.done;
					return persist(id, {
						lastCompletedChunk: progress.lastCompletedChunk,
						progress: { done: dataDone + tilesProcessed, total: combinedTotal },
						nodeCount: progress.nodeCount
					});
				}
			},
			signal
		);

		const tileTask = (async () => {
			// Assets first (small, idempotent) so labels/icons render as soon as the
			// tiles arrive.
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
		})();

		try {
			// Fail fast: the first task to reject stops the wait; the catch then
			// aborts the sibling so it doesn't keep running after a failure/cancel.
			await Promise.all([dataTask, tileTask]);

			await persist(id, {
				status: 'ready',
				lastRefreshedAt: Date.now(),
				tileCount: tilesProcessed,
				sizeBytes,
				progress: { done: combinedTotal, total: combinedTotal }
			});
		} catch (error) {
			// Capture the cancel/failure distinction BEFORE aborting the sibling
			// (our own abort below would otherwise make `signal.aborted` always
			// true). A user cancel already has the signal aborted; a genuine task
			// failure does not.
			const userCancelled = signal.aborted;
			// Cancel the still-running sibling and let both tasks unwind before we
			// record the outcome, so no late progress write revives the area after
			// we mark it `error`.
			controller.abort();
			await Promise.allSettled([dataTask, tileTask]);
			// Both a user cancel and a genuine failure leave the area
			// `error`/incomplete: its persisted `lastCompletedChunk` is the resume
			// point, and the UI offers "Resume download". removeArea's abort is a
			// no-op here since the record is deleted concurrently.
			if (!userCancelled) {
				console.error('Offline area download failed:', error);
			}
			await persist(id, { status: 'error' });
		} finally {
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
	 * Updates an existing area's download settings. `autoRefreshOnWifi` is
	 * always just persisted; satellite/terrain changes additionally download the
	 * newly enabled source or delete the disabled one's tiles, and are ignored
	 * while a download/refresh is in flight (the tile task iterates a snapshot
	 * of the enabled sources, so racing it would corrupt refs/progress).
	 */
	async function updateAreaSettings(
		id: number,
		patch: Partial<Pick<OfflineArea, 'includeSatellite' | 'includeTerrain' | 'autoRefreshOnWifi'>>
	): Promise<void> {
		const area = areas.value.find((a) => a.id === id);
		if (!area || area.id == null) return;

		if (
			patch.autoRefreshOnWifi !== undefined &&
			patch.autoRefreshOnWifi !== area.autoRefreshOnWifi
		) {
			await persist(id, { autoRefreshOnWifi: patch.autoRefreshOnWifi });
			// An already-overdue area should refresh right away once opted in.
			if (patch.autoRefreshOnWifi) void checkAutoRefresh();
		}

		if (controllers.has(id)) return;

		// Disables run first (they need the current tile refs); enabled flags are
		// collected and started as one resume download below.
		const enablePatch: Partial<OfflineArea> = {};
		let needsDownload = false;

		for (const flag of ['includeSatellite', 'includeTerrain'] as const) {
			const next = patch[flag];
			if (next === undefined || next === area[flag]) continue;
			const source = flag === 'includeSatellite' ? 'satellite' : 'terrain';

			if (next) {
				enablePatch[flag] = true;
				needsDownload = true;
				continue;
			}

			const { refsRemoved, bytesFreed } = await tileStore.deleteAreaSource(id, source);
			const current = areas.value.find((a) => a.id === id) ?? area;
			const tileResume = { ...(current.tileResume ?? {}) };
			delete tileResume[source];
			// sizeBytes only ever counted genuinely-new bytes and bytesFreed excludes
			// tiles shared with overlapping areas, so the counter can drift slightly
			// across enable/disable cycles — acceptable for a storage display.
			await persist(id, {
				[flag]: false,
				tileResume,
				tileCount: Math.max(0, current.tileCount - refsRemoved),
				sizeBytes: Math.max(0, current.sizeBytes - bytesFreed)
			});
		}

		if (needsDownload) {
			await persist(id, enablePatch);
			// Resume-path download fetches only the new source(s): the data-chunk
			// loop no-ops for a completed area and tileResume fast-forwards sources
			// already on disk. Accepted quirks: the success path bumps
			// lastRefreshedAt even though no Overpass data was refetched, and the
			// area passes through `downloading`, so coverage gating treats it as
			// uncovered for the duration.
			void runDownload(id, false);
		}
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
		init,
		createArea,
		retryArea,
		refreshArea,
		cancelDownload,
		renameArea,
		updateAreaSettings,
		removeArea,
		checkAutoRefresh,
		isDownloading
	};
});
