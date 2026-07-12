<template>
	<ion-page>
		<ion-header :translucent="true">
			<ion-toolbar>
				<ion-buttons slot="start">
					<ion-back-button default-href="/settings/offline-areas"></ion-back-button>
				</ion-buttons>
				<ion-title>{{ area?.name ?? '' }}</ion-title>
			</ion-toolbar>
		</ion-header>

		<ion-content :fullscreen="true">
			<template v-if="area">
				<!-- Read-only coverage map: offline://-served so it renders without a
				     connection inside a downloaded region. -->
				<div ref="mapContainer" class="coverage-map"></div>

				<ion-list>
					<ion-item lines="full">
						<ion-label>
							<p>{{ statusLine(area) }}</p>
							<ion-progress-bar
								v-if="busy"
								type="determinate"
								:value="progressValue(area)"
							></ion-progress-bar>
						</ion-label>
					</ion-item>
					<ion-item>
						<ion-label>{{ $t('offlineAreas.detail.waterSources') }}</ion-label>
						<ion-note slot="end">{{ formatCount(area.nodeCount) }}</ion-note>
					</ion-item>
					<ion-item>
						<ion-label>{{ $t('offlineAreas.detail.mapTiles') }}</ion-label>
						<ion-note slot="end">{{ formatCount(area.tileCount) }}</ion-note>
					</ion-item>
					<ion-item>
						<ion-label>{{ $t('offlineAreas.detail.storage') }}</ion-label>
						<ion-note slot="end">{{ formatBytes(area.sizeBytes, locale) }}</ion-note>
					</ion-item>
					<ion-item>
						<ion-label>{{ $t('offlineAreas.detail.created') }}</ion-label>
						<ion-note slot="end">{{ formatDate(area.createdAt) }}</ion-note>
					</ion-item>
					<ion-item lines="full">
						<ion-label>{{ $t('offlineAreas.detail.lastRefreshed') }}</ion-label>
						<ion-note slot="end">
							{{
								area.lastRefreshedAt
									? formatDate(area.lastRefreshedAt)
									: $t('offlineAreas.detail.neverRefreshed')
							}}
						</ion-note>
					</ion-item>
				</ion-list>

				<ion-list>
					<ion-list-header>
						<ion-label>{{ $t('offlineAreas.detail.downloadSettings') }}</ion-label>
					</ion-list-header>
					<ion-item :key="`satellite-${settingsVersion}`">
						<ion-label>
							<h3>{{ $t('offlineAreas.add.includeSatellite') }}</h3>
							<p v-if="!area.includeSatellite" class="wrap-note">
								{{ additionalDownloadLine('satellite') }}
							</p>
						</ion-label>
						<ion-toggle
							slot="end"
							:checked="area.includeSatellite"
							:disabled="sourceToggleDisabled('includeSatellite')"
							@ion-change="onSourceToggle('includeSatellite', $event.detail.checked)"
						></ion-toggle>
					</ion-item>
					<ion-item :key="`terrain-${settingsVersion}`">
						<ion-label>
							<h3>{{ $t('offlineAreas.add.includeTerrain') }}</h3>
							<p class="wrap-note">{{ $t('offlineAreas.add.includeTerrainHint') }}</p>
							<p v-if="!area.includeTerrain" class="wrap-note">
								{{ additionalDownloadLine('terrain') }}
							</p>
						</ion-label>
						<ion-toggle
							slot="end"
							:checked="area.includeTerrain"
							:disabled="sourceToggleDisabled('includeTerrain')"
							@ion-change="onSourceToggle('includeTerrain', $event.detail.checked)"
						></ion-toggle>
					</ion-item>
					<ion-item lines="full">
						<ion-label>
							<h3>{{ $t('offlineAreas.add.autoRefresh') }}</h3>
							<p class="wrap-note">{{ $t('offlineAreas.add.autoRefreshHint') }}</p>
						</ion-label>
						<ion-toggle
							slot="end"
							:checked="area.autoRefreshOnWifi"
							@ion-change="onAutoRefreshToggle($event.detail.checked)"
						></ion-toggle>
					</ion-item>
				</ion-list>

				<ion-list>
					<ion-item v-if="busy" button :detail="false" @click="onCancel">
						<ion-icon slot="start" :icon="closeCircleOutline" color="danger"></ion-icon>
						<ion-label color="danger">{{ $t('offlineAreas.actions.cancel') }}</ion-label>
					</ion-item>
					<ion-item v-if="area.status === 'error' && !busy" button :detail="false" @click="onRetry">
						<ion-icon slot="start" :icon="refreshOutline"></ion-icon>
						<ion-label>{{ $t('offlineAreas.actions.retry') }}</ion-label>
					</ion-item>
					<ion-item button :detail="false" :disabled="!isOnline || busy" @click="onRefresh">
						<ion-icon slot="start" :icon="refreshOutline"></ion-icon>
						<ion-label>{{ $t('offlineAreas.actions.refresh') }}</ion-label>
					</ion-item>
					<ion-item button :detail="false" @click="promptRename(area)">
						<ion-icon slot="start" :icon="createOutline"></ion-icon>
						<ion-label>{{ $t('offlineAreas.actions.rename') }}</ion-label>
					</ion-item>
					<ion-item button :detail="false" lines="full" @click="onDelete">
						<ion-icon slot="start" :icon="trashOutline" color="danger"></ion-icon>
						<ion-label color="danger">{{ $t('offlineAreas.actions.delete') }}</ion-label>
					</ion-item>
				</ion-list>
			</template>
		</ion-content>
	</ion-page>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
	IonPage,
	IonHeader,
	IonToolbar,
	IonButtons,
	IonBackButton,
	IonTitle,
	IonContent,
	IonList,
	IonListHeader,
	IonItem,
	IonLabel,
	IonNote,
	IonIcon,
	IonToggle,
	IonProgressBar,
	alertController,
	onIonViewDidEnter
} from '@ionic/vue';
import { refreshOutline, createOutline, trashOutline, closeCircleOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers as protomapsLayers } from '@protomaps/basemaps';
import { outdoorsFlavor } from '@/map/outdoorsFlavor';
import { nightFlavor } from '@/map/nightFlavor';
import { useDarkMode } from '@/composable/darkModeDetection';
import { useNetworkStatus } from '@/composable/networkStatus';
import { useOfflineAreasStore } from '@/store/offlineAreasStore';
import {
	useOfflineAreaActions,
	estimateSourceBytes,
	estimateRangeMb
} from '@/composable/offlineAreaActions';
import { formatBytes } from '@/helper/helper';
import type { OfflineArea } from '@/mapHandler/databaseHandler';

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const { isOnline } = useNetworkStatus();
const { isDarkMode } = useDarkMode();

const store = useOfflineAreasStore();
const {
	formatCount,
	formatDate,
	progressValue,
	statusLine,
	promptRename,
	confirmDelete,
	showOfflineToast
} = useOfflineAreaActions();

const areaId = computed(() => Number(route.params.id));
const area = computed(() => store.areas.find((a) => a.id === areaId.value));
/** Transient statuses imply an in-flight run: init() marks orphans `error`. */
const busy = computed(
	() => area.value?.status === 'downloading' || area.value?.status === 'refreshing'
);

/** Set before delete-navigation so the missing-area redirect doesn't also fire. */
let deleting = false;
const initialized = ref(false);

// A deleted/unknown id has nothing to show — go back to the list. `router.replace`
// keeps an accidental double navigation harmless.
watch(area, (a) => {
	if (!a && initialized.value && !deleting) {
		router.replace('/settings/offline-areas');
	}
});

// --- Coverage mini-map -------------------------------------------------------

const mapContainer = ref<HTMLElement | null>(null);
let map: maplibregl.Map | null = null;

/**
 * Offline-capable style: unlike the add-modal picker (direct Protomaps API),
 * everything routes through the `offline://` protocol so the coverage map
 * renders inside a downloaded region without a connection.
 */
function buildStyle(): maplibregl.StyleSpecification {
	const flavor = isDarkMode.value ? nightFlavor : outdoorsFlavor;
	const spriteFlavor = isDarkMode.value ? 'dark' : 'light';
	return {
		version: 8,
		glyphs: 'offline://assets/fonts/{fontstack}/{range}.pbf',
		sprite: `offline://assets/sprites/v4/${spriteFlavor}`,
		sources: {
			protomaps: {
				type: 'vector',
				tiles: ['offline://protomaps/{z}/{x}/{y}'],
				minzoom: 0,
				maxzoom: 15,
				attribution:
					'&copy; <a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
			}
		},
		layers: protomapsLayers('protomaps', flavor, { lang: locale.value || 'en' })
	};
}

function fitArea(): void {
	const b = area.value?.bounds;
	if (!map || !b) return;
	map.fitBounds(
		[
			[b.west, b.south],
			[b.east, b.north]
		],
		{ padding: 32, duration: 0 }
	);
}

function createMap(): void {
	const b = area.value?.bounds;
	if (!mapContainer.value || map || !b) return;
	map = new maplibregl.Map({
		container: mapContainer.value,
		style: buildStyle(),
		interactive: false,
		attributionControl: false
	});
	map.on('load', () => {
		if (!map) return;
		map.resize();
		const primary =
			getComputedStyle(document.documentElement).getPropertyValue('--ion-color-primary').trim() ||
			'#b3261e';
		map.addSource('area-bounds', {
			type: 'geojson',
			data: {
				type: 'Feature',
				properties: {},
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[b.west, b.south],
							[b.east, b.south],
							[b.east, b.north],
							[b.west, b.north],
							[b.west, b.south]
						]
					]
				}
			}
		});
		map.addLayer({
			id: 'area-bounds-fill',
			type: 'fill',
			source: 'area-bounds',
			paint: { 'fill-color': primary, 'fill-opacity': 0.12 }
		});
		map.addLayer({
			id: 'area-bounds-line',
			type: 'line',
			source: 'area-bounds',
			paint: { 'line-color': primary, 'line-width': 2 }
		});
		fitArea();
	});
}

onMounted(async () => {
	// Idempotent — makes cold-start deep links onto this route work.
	await store.init();
	initialized.value = true;
	if (!area.value) {
		router.replace('/settings/offline-areas');
		return;
	}
	await nextTick();
	createMap();
});

// Ionic's page transition can leave the canvas mis-sized on first paint.
onIonViewDidEnter(() => {
	map?.resize();
	fitArea();
});

onUnmounted(() => {
	map?.remove();
	map = null;
});

// --- Download settings -------------------------------------------------------

/** Bumped when a toggle change is rejected, to snap the control back to state. */
const settingsVersion = ref(0);

type SourceFlag = 'includeSatellite' | 'includeTerrain';

function sourceToggleDisabled(flag: SourceFlag): boolean {
	const a = area.value;
	if (!a) return true;
	// Enabling needs a connection; disabling (frees tiles) works offline.
	return busy.value || (!a[flag] && !isOnline.value);
}

function additionalDownloadLine(source: 'satellite' | 'terrain'): string {
	const a = area.value;
	if (!a) return '';
	const { low, high } = estimateRangeMb(estimateSourceBytes(a.bounds, source));
	return t('offlineAreas.detail.additionalDownload', {
		low: formatCount(low),
		high: formatCount(high)
	});
}

async function confirmRemoveTiles(label: string): Promise<boolean> {
	const alert = await alertController.create({
		header: t('offlineAreas.detail.removeTilesDialog.title'),
		message: t('offlineAreas.detail.removeTilesDialog.message', { label }),
		buttons: [
			{ text: t('common.cancel'), role: 'cancel' },
			{ text: t('offlineAreas.detail.removeTilesDialog.remove'), role: 'destructive' }
		]
	});
	await alert.present();
	const { role } = await alert.onDidDismiss();
	return role === 'destructive';
}

async function onSourceToggle(flag: SourceFlag, checked: boolean): Promise<void> {
	const a = area.value;
	if (!a || a.id == null || checked === a[flag] || busy.value) return;
	if (checked && !isOnline.value) {
		settingsVersion.value++;
		void showOfflineToast();
		return;
	}
	if (!checked) {
		const label = t(
			flag === 'includeSatellite'
				? 'offlineAreas.add.includeSatellite'
				: 'offlineAreas.add.includeTerrain'
		);
		if (!(await confirmRemoveTiles(label))) {
			settingsVersion.value++;
			return;
		}
	}
	await store.updateAreaSettings(a.id, { [flag]: checked });
}

async function onAutoRefreshToggle(checked: boolean): Promise<void> {
	const a = area.value;
	if (!a || a.id == null || checked === a.autoRefreshOnWifi) return;
	await store.updateAreaSettings(a.id, { autoRefreshOnWifi: checked });
}

// --- Actions -----------------------------------------------------------------

function onRefresh(): void {
	const a = area.value;
	if (!a || a.id == null) return;
	if (!isOnline.value) return void showOfflineToast();
	void store.refreshArea(a.id);
}

function onRetry(): void {
	const a = area.value;
	if (!a || a.id == null) return;
	if (!isOnline.value) return void showOfflineToast();
	void store.retryArea(a.id);
}

function onCancel(): void {
	const a = area.value;
	if (a?.id != null) store.cancelDownload(a.id);
}

function onDelete(): void {
	const a = area.value;
	if (!a) return;
	void confirmDelete(a as OfflineArea, () => {
		deleting = true;
		router.replace('/settings/offline-areas');
	});
}
</script>

<style scoped>
.coverage-map {
	width: 100%;
	height: 40vh;
	min-height: 240px;
}

.wrap-note {
	white-space: normal;
}
</style>
