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

		const controller = new AbortController();
		controllers.set(id, controller);

		const startChunk = refresh ? -1 : area.lastCompletedChunk;
		await persist(id, {
			status: refresh ? 'refreshing' : 'downloading',
			lastCompletedChunk: startChunk,
			progress: { done: Math.max(startChunk + 1, 0), total: countChunks(area.bounds) }
		});

		try {
			await downloadAreaData(
				{
					bounds: area.bounds,
					lastCompletedChunk: startChunk,
					baseNodeCount: area.nodeCount,
					refresh,
					onProgress: (progress) =>
						persist(id, {
							lastCompletedChunk: progress.lastCompletedChunk,
							progress: { done: progress.done, total: progress.total },
							nodeCount: progress.nodeCount
						})
				},
				controller.signal
			);
			await persist(id, { status: 'ready', lastRefreshedAt: Date.now() });
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
		await deleteOfflineArea(id);
		areas.value = areas.value.filter((area) => area.id !== id);
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
		removeArea,
		checkAutoRefresh,
		isDownloading
	};
});
