<template>
	<ion-page>
		<ion-header :translucent="true">
			<ion-toolbar>
				<ion-buttons slot="start">
					<ion-back-button default-href="/settings"></ion-back-button>
				</ion-buttons>
				<ion-title>{{ $t('offlineAreas.title') }}</ion-title>
				<ion-buttons slot="end">
					<ion-button :disabled="!isOnline" @click="openAddModal()">
						<ion-icon slot="icon-only" :icon="add"></ion-icon>
					</ion-button>
				</ion-buttons>
			</ion-toolbar>
		</ion-header>

		<ion-content :fullscreen="true">
			<!-- Offline hint: downloads need a connection -->
			<div v-if="!isOnline" class="offline-hint">
				<ion-icon :icon="cloudOfflineOutline"></ion-icon>
				<span>{{ $t('offlineAreas.offlineHint') }}</span>
			</div>

			<!-- Empty state -->
			<div v-if="!areas.length" class="empty-state">
				<ion-icon :icon="mapOutline" class="empty-icon"></ion-icon>
				<h2>{{ $t('offlineAreas.empty.title') }}</h2>
				<p>{{ $t('offlineAreas.empty.description') }}</p>
				<ion-button :disabled="!isOnline" @click="openAddModal()">
					<ion-icon slot="start" :icon="add"></ion-icon>
					{{ $t('offlineAreas.add.button') }}
				</ion-button>
			</div>

			<ion-list v-else>
				<ion-item
					v-for="area in areas"
					:key="area.id"
					lines="full"
					button
					:detail="true"
					@click="openDetail(area)"
				>
					<ion-icon slot="start" :icon="mapOutline"></ion-icon>
					<ion-label>
						<h2>{{ area.name }}</h2>
						<p>{{ statusLine(area) }}</p>
						<!-- Water-source (Overpass) data and tiles download in parallel and
						     both count toward one determinate bar; the status line notes
						     while the water-source fetch is still pending. -->
						<ion-progress-bar
							v-if="area.status === 'downloading' || area.status === 'refreshing'"
							type="determinate"
							:value="progressValue(area)"
						></ion-progress-bar>
					</ion-label>
					<ion-button slot="end" fill="clear" @click.stop="openActions(area)">
						<ion-icon slot="icon-only" :icon="ellipsisVertical"></ion-icon>
					</ion-button>
				</ion-item>
			</ion-list>
		</ion-content>

		<!-- Add-area modal -->
		<ion-modal
			:is-open="addModalOpen"
			@didPresent="onModalPresented"
			@didDismiss="onModalDismissed"
		>
			<ion-header>
				<ion-toolbar>
					<ion-buttons slot="start">
						<ion-button @click="addModalOpen = false" :title="$t('common.cancel')">
							<ion-icon slot="icon-only" :icon="close"></ion-icon>
						</ion-button>
					</ion-buttons>
					<ion-title>{{ $t('offlineAreas.add.title') }}</ion-title>
				</ion-toolbar>
			</ion-header>
			<ion-content>
				<!-- Map picker with a fixed centered capture rectangle -->
				<div class="picker-map-wrap">
					<div ref="pickerContainer" class="picker-map"></div>
					<div class="capture-rect"></div>
					<div class="capture-caption">{{ $t('offlineAreas.add.captureHint') }}</div>
				</div>

				<div class="picker-form">
					<!-- Radius presets around the device location -->
					<div class="radius-presets">
						<span class="radius-label">{{ $t('offlineAreas.add.radiusLabel') }}</span>
						<ion-chip
							v-for="preset in radiusPresets"
							:key="preset"
							:disabled="locating"
							@click="applyRadiusPreset(preset)"
						>
							<ion-icon :icon="locationOutline"></ion-icon>
							<ion-label>{{ preset / 1000 }} km</ion-label>
						</ion-chip>
					</div>

					<ion-item>
						<ion-input
							:label="$t('offlineAreas.add.nameLabel')"
							label-placement="stacked"
							:value="name"
							@ion-input="name = String($event.detail.value ?? '')"
						></ion-input>
					</ion-item>

					<ion-item>
						<ion-label>{{ $t('offlineAreas.add.includeSatellite') }}</ion-label>
						<ion-toggle
							slot="end"
							:checked="includeSatellite"
							@ion-change="includeSatellite = $event.detail.checked"
						></ion-toggle>
					</ion-item>
					<ion-item>
						<ion-label>
							<h3>{{ $t('offlineAreas.add.includeTerrain') }}</h3>
							<p class="wrap-note">{{ $t('offlineAreas.add.includeTerrainHint') }}</p>
						</ion-label>
						<ion-toggle
							slot="end"
							:checked="includeTerrain"
							@ion-change="includeTerrain = $event.detail.checked"
						></ion-toggle>
					</ion-item>
					<ion-item>
						<ion-label>
							<h3>{{ $t('offlineAreas.add.autoRefresh') }}</h3>
							<p class="wrap-note">{{ $t('offlineAreas.add.autoRefreshHint') }}</p>
						</ion-label>
						<ion-toggle
							slot="end"
							:checked="autoRefreshOnWifi"
							@ion-change="autoRefreshOnWifi = $event.detail.checked"
						></ion-toggle>
					</ion-item>

					<div class="estimate">
						<p>{{ estimateLine }}</p>
						<p v-if="sizeEstimateLine">{{ sizeEstimateLine }}</p>
						<p v-if="tooLarge" class="estimate-error">
							{{ $t('offlineAreas.add.tooLarge') }}
						</p>
					</div>

					<ion-button
						expand="block"
						:disabled="!isOnline || tooLarge || !selectedBounds"
						@click="confirmDownload()"
					>
						<ion-icon slot="start" :icon="cloudDownloadOutline"></ion-icon>
						{{ $t('offlineAreas.add.download') }}
					</ion-button>
				</div>
			</ion-content>
		</ion-modal>
	</ion-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
	IonPage,
	IonHeader,
	IonToolbar,
	IonButtons,
	IonBackButton,
	IonButton,
	IonTitle,
	IonContent,
	IonList,
	IonItem,
	IonLabel,
	IonIcon,
	IonProgressBar,
	IonModal,
	IonInput,
	IonToggle,
	IonChip,
	actionSheetController,
	toastController
} from '@ionic/vue';
import {
	add,
	close,
	ellipsisVertical,
	mapOutline,
	locationOutline,
	cloudDownloadOutline,
	cloudOfflineOutline,
	refreshOutline,
	createOutline,
	trashOutline,
	closeCircleOutline
} from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { storeToRefs } from 'pinia';
import { GeoBounds, GeoPoint } from '@/types/geo';
import { useNetworkStatus } from '@/composable/networkStatus';
import { useOfflineAreasStore, isAreaTooLarge } from '@/store/offlineAreasStore';
import { countChunks } from '@/offline/areaDataDownloader';
import {
	useOfflineAreaActions,
	estimateSourceBytes,
	estimateRangeMb
} from '@/composable/offlineAreaActions';
import type { OfflineArea } from '@/mapHandler/databaseHandler';

const { t, locale } = useI18n();
const { isOnline } = useNetworkStatus();
const router = useRouter();

const store = useOfflineAreasStore();
const { areas } = storeToRefs(store);
const { formatCount, progressValue, statusLine, promptRename, confirmDelete, showOfflineToast } =
	useOfflineAreaActions();

const PROTOMAPS_API_KEY = import.meta.env.VITE_PROTOMAPS_API_KEY;
/** Inset of the capture rectangle from the map edges (px). Also fitBounds padding. */
const INSET_PX = 28;
const radiusPresets = [2000, 5000, 10000];

onMounted(() => {
	store.init();
});

// --- Per-area actions ------------------------------------------------------

function openDetail(area: OfflineArea): void {
	if (area.id == null) return;
	router.push(`/settings/offline-areas/${area.id}`);
}

async function openActions(area: OfflineArea): Promise<void> {
	if (area.id == null) return;
	const id = area.id;
	const buttons: Parameters<typeof actionSheetController.create>[0]['buttons'] = [];

	if (store.isDownloading(id)) {
		buttons.push({
			text: t('offlineAreas.actions.cancel'),
			icon: closeCircleOutline,
			role: 'destructive',
			handler: () => store.cancelDownload(id)
		});
	} else {
		if (area.status === 'error') {
			buttons.push({
				text: t('offlineAreas.actions.retry'),
				icon: refreshOutline,
				handler: () => {
					if (!isOnline.value) return void showOfflineToast();
					store.retryArea(id);
				}
			});
		}
		buttons.push({
			text: t('offlineAreas.actions.refresh'),
			icon: refreshOutline,
			handler: () => {
				if (!isOnline.value) return void showOfflineToast();
				store.refreshArea(id);
			}
		});
		buttons.push({
			text: t('offlineAreas.actions.rename'),
			icon: createOutline,
			handler: () => void promptRename(area)
		});
		buttons.push({
			text: t('offlineAreas.actions.delete'),
			icon: trashOutline,
			role: 'destructive',
			handler: () => void confirmDelete(area)
		});
	}

	buttons.push({ text: t('common.cancel'), role: 'cancel' });

	const sheet = await actionSheetController.create({ header: area.name, buttons });
	await sheet.present();
}

// --- Add-area modal + map picker ------------------------------------------

const addModalOpen = ref(false);
const pickerContainer = ref<HTMLElement | null>(null);
let pickerMap: maplibregl.Map | null = null;

const name = ref('');
const includeSatellite = ref(false);
const includeTerrain = ref(false);
const autoRefreshOnWifi = ref(false);
const locating = ref(false);
const selectedBounds = ref<GeoBounds | null>(null);

const tooLarge = computed(() =>
	selectedBounds.value ? isAreaTooLarge(selectedBounds.value) : false
);

const estimateLine = computed(() => {
	const b = selectedBounds.value;
	if (!b) return '';
	const midLat = (b.north + b.south) / 2;
	const widthKm = (b.east - b.west) * 111 * Math.cos((midLat * Math.PI) / 180);
	const heightKm = (b.north - b.south) * 111;
	return t('offlineAreas.add.estimate', {
		width: widthKm.toFixed(1),
		height: heightKm.toFixed(1),
		chunks: countChunks(b)
	});
});

/** Estimated total download bytes for the current bounds + toggles. */
const estimateBytes = computed(() => {
	const b = selectedBounds.value;
	if (!b) return 0;
	let bytes = estimateSourceBytes(b, 'protomaps');
	if (includeSatellite.value) bytes += estimateSourceBytes(b, 'satellite');
	if (includeTerrain.value) bytes += estimateSourceBytes(b, 'terrain');
	return bytes;
});

/** Formats the estimate as a range string, e.g. "30–50 MB". */
const sizeEstimateLine = computed(() => {
	if (!selectedBounds.value) return '';
	const { low, high } = estimateRangeMb(estimateBytes.value);
	return t('offlineAreas.add.sizeEstimate', { low: formatCount(low), high: formatCount(high) });
});

function openAddModal(): void {
	name.value = t('offlineAreas.add.defaultName');
	includeSatellite.value = false;
	// Terrain defaults on: its elevation data powers the offline pump calculation.
	includeTerrain.value = true;
	autoRefreshOnWifi.value = false;
	selectedBounds.value = null;
	addModalOpen.value = true;
}

function buildPickerStyle(): maplibregl.StyleSpecification {
	return {
		version: 8,
		glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
		sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
		sources: {
			protomaps: {
				type: 'vector',
				url: `https://api.protomaps.com/tiles/v4.json?key=${PROTOMAPS_API_KEY}`,
				attribution:
					'&copy; <a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
			}
		},
		layers: protomapsLayers('protomaps', namedFlavor('light'), { lang: locale.value || 'en' })
	};
}

/** Computes the geographic bounds of the inset capture rectangle. */
function boundsFromRect(map: maplibregl.Map): GeoBounds {
	const canvas = map.getCanvas();
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	const nw = map.unproject([INSET_PX, INSET_PX]);
	const se = map.unproject([width - INSET_PX, height - INSET_PX]);
	return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}

function updateSelectedBounds(): void {
	if (pickerMap) selectedBounds.value = boundsFromRect(pickerMap);
}

function onModalPresented(): void {
	if (!pickerContainer.value || pickerMap) return;
	pickerMap = new maplibregl.Map({
		container: pickerContainer.value,
		style: buildPickerStyle(),
		center: [15.274102, 48.135314],
		zoom: 12,
		attributionControl: false
	});
	pickerMap.on('load', () => {
		pickerMap?.resize();
		updateSelectedBounds();
	});
	pickerMap.on('moveend', updateSelectedBounds);
}

function onModalDismissed(): void {
	pickerMap?.remove();
	pickerMap = null;
	selectedBounds.value = null;
}

/**
 * Resolves the current device location, requesting permission on native. Shows
 * a toast and returns null on failure so the presets fail gracefully.
 */
async function getDeviceLocation(): Promise<GeoPoint | null> {
	try {
		if (Capacitor.isNativePlatform()) {
			const perm = await Geolocation.checkPermissions();
			if (perm.location !== 'granted') {
				const req = await Geolocation.requestPermissions();
				if (req.location !== 'granted') return null;
			}
		}
		const position = await Geolocation.getCurrentPosition({
			enableHighAccuracy: true,
			timeout: 10000,
			maximumAge: 0
		});
		return { lat: position.coords.latitude, lng: position.coords.longitude };
	} catch {
		return null;
	}
}

async function applyRadiusPreset(radiusMeters: number): Promise<void> {
	if (!pickerMap) return;
	locating.value = true;
	try {
		const loc = await getDeviceLocation();
		if (!loc) {
			const toast = await toastController.create({
				message: t('offlineAreas.add.locationError'),
				duration: 3000
			});
			await toast.present();
			return;
		}
		const latDelta = radiusMeters / 111000;
		const lngDelta = radiusMeters / (111000 * Math.cos((loc.lat * Math.PI) / 180));
		// Pad by the rectangle inset so the radius box lands inside the capture rect.
		pickerMap.fitBounds(
			[
				[loc.lng - lngDelta, loc.lat - latDelta],
				[loc.lng + lngDelta, loc.lat + latDelta]
			],
			{ padding: INSET_PX, duration: 400 }
		);
	} finally {
		locating.value = false;
	}
}

async function confirmDownload(): Promise<void> {
	if (!selectedBounds.value || tooLarge.value || !isOnline.value) return;
	const trimmed = name.value.trim() || t('offlineAreas.add.defaultName');
	await store.createArea({
		name: trimmed,
		bounds: selectedBounds.value,
		includeSatellite: includeSatellite.value,
		includeTerrain: includeTerrain.value,
		autoRefreshOnWifi: autoRefreshOnWifi.value
	});
	addModalOpen.value = false;
}
</script>

<style scoped>
.empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	text-align: center;
	padding: 48px 24px;
	gap: 8px;
}

.empty-icon {
	font-size: 64px;
	color: var(--md-sys-on-surface-variant);
}

.offline-hint {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 16px;
	color: var(--md-sys-on-surface-variant);
	font-size: 0.9rem;
}

.picker-map-wrap {
	position: relative;
	width: 100%;
	height: 45vh;
	min-height: 260px;
	/* Clip the capture-rect's 9999px box-shadow scrim to the map — without
	   this it bleeds over the whole modal body and dims every transparent
	   area (chips row, estimate, button margins) to a muddy gray. */
	overflow: hidden;
}

.picker-map {
	position: absolute;
	inset: 0;
}

.capture-rect {
	position: absolute;
	inset: 28px;
	border: 2px solid var(--ion-color-primary);
	border-radius: 6px;
	box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.18);
	pointer-events: none;
}

.capture-caption {
	position: absolute;
	left: 50%;
	bottom: 36px;
	transform: translateX(-50%);
	background: var(--ion-color-primary);
	color: #fff;
	font-size: 0.8rem;
	padding: 4px 10px;
	border-radius: 12px;
	pointer-events: none;
}

.picker-form {
	padding: 8px 0 24px;
}

.radius-presets {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 4px;
	padding: 12px 16px 4px;
}

.radius-label {
	font-size: 0.9rem;
	color: var(--md-sys-on-surface-variant);
	margin-right: 4px;
}

.estimate {
	padding: 12px 16px;
	font-size: 0.9rem;
	color: var(--md-sys-on-surface-variant);
}

.estimate-error {
	color: var(--ion-color-danger);
}

.wrap-note {
	white-space: normal;
}

.picker-form ion-button {
	margin: 8px 16px 0;
}
</style>
