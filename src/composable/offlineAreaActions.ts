import { alertController, toastController } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import { useOfflineAreasStore } from '@/store/offlineAreasStore';
import {
	tileCount,
	PROTOMAPS_MAX_ZOOM,
	SATELLITE_MAX_ZOOM,
	TERRAIN_MAX_ZOOM
} from '@/offline/tileMath';
import type { GeoBounds } from '@/types/geo';
import { isDataPhaseDone, type OfflineArea } from '@/mapHandler/databaseHandler';

/**
 * Calibration constants for pre-download size estimates. Average compressed
 * bytes per tile per source — rough, so estimates are shown as a ±40% range
 * rather than a fake exact figure.
 */
export const AVG_TILE_BYTES: Record<string, number> = {
	protomaps: 45_000,
	satellite: 25_000,
	terrain: 35_000
};

const SOURCE_MAX_ZOOM: Record<string, number> = {
	protomaps: PROTOMAPS_MAX_ZOOM,
	satellite: SATELLITE_MAX_ZOOM,
	terrain: TERRAIN_MAX_ZOOM
};

/** Estimated download bytes for one tile source over the given bounds. */
export function estimateSourceBytes(bounds: GeoBounds, source: string): number {
	return tileCount(bounds, 0, SOURCE_MAX_ZOOM[source]) * AVG_TILE_BYTES[source];
}

/** Widens a byte estimate into a ±40% MB range (raw numbers, not localized). */
export function estimateRangeMb(bytes: number): { low: number; high: number } {
	const mb = bytes / (1024 * 1024);
	const low = Math.max(1, Math.round(mb * 0.6));
	const high = Math.max(low, Math.round(mb * 1.4));
	return { low, high };
}

/**
 * Shared helpers for the offline-area UIs (list view + detail view): status
 * and progress rendering plus the rename/delete dialogs.
 */
export function useOfflineAreaActions() {
	const { t, locale } = useI18n();
	const store = useOfflineAreasStore();

	function formatCount(value: number): string {
		return value.toLocaleString(locale.value || 'en');
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString(locale.value || 'en', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function progressValue(area: OfflineArea): number {
		if (!area.progress.total) return 0;
		return area.progress.done / area.progress.total;
	}

	/**
	 * Progress text for an in-flight download. Water-source data and tiles run in
	 * parallel, so this shows the overall tile-inclusive percentage plus, while
	 * the water-source read is still pending, a line for it.
	 *
	 * The data phase is a single FlatGeobuf bbox read (§4.6), so there is no
	 * counter to show any more — `lastCompletedChunk` is now just a done flag,
	 * not a chunk index. Read it through `isDataPhaseDone` so a legacy chunk
	 * index on a record from the old chunked downloader isn't mistaken for
	 * "sources already loaded" while the data read is in fact still running.
	 */
	function downloadDetail(area: OfflineArea, refreshing: boolean): string {
		const parts: string[] = [];

		if (!isDataPhaseDone(area)) {
			parts.push(
				t(
					refreshing
						? 'offlineAreas.status.refreshingSources'
						: 'offlineAreas.status.loadingSources'
				)
			);
		}

		parts.push(
			t(refreshing ? 'offlineAreas.status.refreshingTiles' : 'offlineAreas.status.loadingTiles', {
				percent: Math.round(progressValue(area) * 100)
			})
		);

		return parts.join(' · ');
	}

	function statusLine(area: OfflineArea): string {
		const parts: string[] = [];
		switch (area.status) {
			case 'downloading':
				parts.push(downloadDetail(area, false));
				break;
			case 'refreshing':
				parts.push(downloadDetail(area, true));
				break;
			case 'error':
				parts.push(t('offlineAreas.status.error'));
				break;
			case 'ready':
				parts.push(t('offlineAreas.status.nodeCount', { count: formatCount(area.nodeCount) }));
				if (area.lastRefreshedAt) {
					parts.push(
						t('offlineAreas.status.lastRefreshed', { date: formatDate(area.lastRefreshedAt) })
					);
				}
				break;
		}
		return parts.join(' · ');
	}

	async function promptRename(area: OfflineArea): Promise<void> {
		if (area.id == null) return;
		const alert = await alertController.create({
			header: t('offlineAreas.actions.rename'),
			inputs: [{ name: 'name', type: 'text', value: area.name }],
			buttons: [
				{ text: t('common.cancel'), role: 'cancel' },
				{
					text: t('common.save'),
					handler: (data) => {
						const next = String(data.name ?? '').trim();
						if (next) store.renameArea(area.id as number, next);
					}
				}
			]
		});
		await alert.present();
	}

	/**
	 * Delete confirmation. `onConfirmed` runs before the store delete starts so
	 * a caller can navigate away first (the detail view would otherwise race its
	 * own missing-area redirect against the delete).
	 */
	async function confirmDelete(area: OfflineArea, onConfirmed?: () => void): Promise<void> {
		if (area.id == null) return;
		const alert = await alertController.create({
			header: t('offlineAreas.deleteDialog.title'),
			message: t('offlineAreas.deleteDialog.message', { name: area.name }),
			buttons: [
				{ text: t('common.cancel'), role: 'cancel' },
				{
					text: t('offlineAreas.actions.delete'),
					role: 'destructive',
					handler: () => {
						onConfirmed?.();
						void store.removeArea(area.id as number);
					}
				}
			]
		});
		await alert.present();
	}

	async function showOfflineToast(): Promise<void> {
		const toast = await toastController.create({
			message: t('offlineAreas.offlineHint'),
			duration: 3000
		});
		await toast.present();
	}

	return {
		formatCount,
		formatDate,
		progressValue,
		downloadDetail,
		statusLine,
		promptRename,
		confirmDelete,
		showOfflineToast
	};
}
