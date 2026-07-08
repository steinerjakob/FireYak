<template>
	<div :class="{ darkMap: isDarkMode && !isSatellite }" style="height: 100%; width: 100%">
		<div id="map" style="height: 100%; width: 100%"></div>
		<AddressSearchBar
			:map-center="mapCenterForSearch"
			@select-result="onSearchResultSelected"
			@about-click="router.push('/about')"
			@settings-click="router.push('/settings')"
			@clear-search="onSearchCleared"
		/>
		<!-- About FAB Button -->
		<ion-fab v-if="!isMobile" vertical="top" horizontal="start" slot="fixed">
			<ion-fab-button
				class="md-small"
				color="light"
				size="small"
				@click="router.push('/about')"
				:title="$t('about.openInfo')"
			>
				<ion-icon :icon="informationCircle"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<ion-fab
			class="layers-fab"
			:class="{ 'layers-fab-offline': !isOnline }"
			vertical="top"
			horizontal="start"
			slot="fixed"
		>
			<ion-fab-button
				class="md-small"
				color="light"
				size="small"
				@click="openLayerSelector($event)"
				:title="$t('about.openInfo')"
			>
				<ion-icon :icon="layers"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<!-- Settings FAB Button -->
		<ion-fab v-if="!isMobile" vertical="top" horizontal="end" slot="fixed">
			<ion-fab-button
				class="md-small"
				color="light"
				size="small"
				@click="router.push('/settings')"
				:title="$t('settings.title')"
			>
				<ion-icon :icon="settings"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<!-- Reset View / Compass FAB (only visible when pitch or bearing changed) -->
		<ion-fab v-if="showResetView" vertical="top" horizontal="end" slot="fixed" class="compass-fab">
			<ion-fab-button
				class="md-small"
				color="light"
				size="small"
				@click="resetView"
				:title="$t('map.resetView')"
			>
				<ion-icon
					:icon="compass"
					:style="{ transform: `rotate(${compassRotation}deg)` }"
				></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<!-- Zoom FAB Buttons -->
		<ion-fab
			v-if="showZoomButtons"
			vertical="center"
			horizontal="end"
			slot="fixed"
			class="zoom-fab"
		>
			<ion-fab-button
				color="light"
				@click="zoomIn"
				size="small"
				:title="$t('map.zoomIn')"
				class="md-small"
			>
				<ion-icon :icon="add"></ion-icon>
			</ion-fab-button>
			<ion-fab-button
				color="light"
				@click="zoomOut"
				size="small"
				:title="$t('map.zoomOut')"
				class="md-small"
			>
				<ion-icon :icon="remove"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<ion-fab vertical="bottom" horizontal="start" slot="fixed">
			<ion-fab-button
				color="light"
				@click="router.push('/supplypipe')"
				:title="$t('pumpCalculation.openInfo')"
			>
				<ion-icon :icon="analyticsOutline"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<!-- Marker fetch indicator — visible for background refreshes too, so the
		     user sees activity while Overpass data loads for the current view -->
		<div v-if="isFetchingMarkers" class="marker-loading-indicator">
			<ion-spinner name="crescent" color="primary"></ion-spinner>
		</div>
		<ion-fab class="location-fab" vertical="bottom" horizontal="end" slot="fixed">
			<ion-fab-button color="light" @click="showUserLocation" title="Location">
				<ion-spinner v-show="waitingForLocation" color="primary"></ion-spinner>
				<ion-icon
					v-show="!waitingForLocation"
					:icon="watchId ? navigate : navigateOutline"
				></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<ion-fab vertical="bottom" horizontal="end" slot="fixed">
			<ion-fab-button color="light" @click="router.push('/nearbysources')" title="Nearby">
				<ion-icon :icon="nearbyMarker" size="large"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<!-- Add Hydrant FAB -->
		<ion-fab class="add-hydrant-fab" vertical="bottom" horizontal="end" slot="fixed">
			<ion-fab-button color="primary" @click="startAdding" :title="$t('markerEdit.title.add')">
				<ion-icon :icon="addOutline"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<LayerSelectorModal
			:is-open="layerModalOpen"
			:event="layerSelectorEvent"
			@update:is-open="layerModalOpen = $event"
		/>
	</div>
</template>
<script lang="ts" setup>
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers as protomapsLayers } from '@protomaps/basemaps';
import selectedMarkerIconUrl from '../assets/markers/selectedmarker.png';
import { nextTick, onMounted, watch, ref, onUnmounted } from 'vue';
import { debounce } from '@/helper/helper';
import {
	getMarkersForView,
	getNearbyMarkers,
	markerIconUrls,
	isFetchingMarkers,
	markerFetchFailed
} from '@/mapHandler/markerHandler';
import { useNetworkStatus } from '@/composable/networkStatus';
import { useRoute, useRouter } from 'vue-router';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { useDarkMode } from '@/composable/darkModeDetection';
import { IonFab, IonFabButton, IonIcon, IonSpinner, toastController } from '@ionic/vue';
import LayerSelectorModal from '@/components/LayerSelectorModal.vue';
import AddressSearchBar from '@/components/AddressSearchBar.vue';
import { useScreenDetection } from '@/composable/screenDetection';
import { usePhotonSearch, type PhotonFeature } from '@/composable/photonSearch';
import {
	informationCircle,
	analyticsOutline,
	navigate,
	navigateOutline,
	add,
	remove,
	settings,
	addOutline,
	layers,
	compass
} from 'ionicons/icons';
import { usePumpCalculation } from '@/composable/pumpCalculation';
import nearbyMarker from '@/assets/icons/nearbyMarker.svg';
import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { useDefaultStore } from '@/store/defaultStore';
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';
import { type MapLayerSetting, useSettingsStore } from '@/store/settingsStore';
import { useMarkerEditStore } from '@/store/markerEditStore';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { GeoPoint, GeoBounds, distanceTo } from '@/types/geo';
import { getRoutedPath } from '@/mapHandler/nearbyRouting';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import { outdoorsFlavor } from '@/map/outdoorsFlavor';
import { nightFlavor } from '@/map/nightFlavor';
import { satelliteFlavor } from '@/map/satelliteFlavor';

const MAP_ELEMENT_ID = 'map';
const MOVE_DEBOUNCE_MS = 300;
const DISABLE_CLUSTERING_ZOOM = 14;
const CLUSTER_RADIUS = 50;
const MARKER_SOURCE_ID = 'markers';
const SELECTED_PATH_SOURCE = 'selected-path';
const SELECTED_PATH_LAYER = 'selected-path-layer';
const SELECTED_PATH_LABEL_LAYER = 'selected-path-label-layer';
const MAP_VIEW_STORAGE_KEY = 'mapView';
// Fallback center used only until the device location resolves on a fresh
// install (no saved view yet). Kept at a low zoom so handleMapMovement's
// `zoom <= 9` guard skips the Overpass fetch for this placeholder view — this
// avoids the wasted Overpass call (and rate-limit contention) that used to
// fire for the default region before jumping to the user's real location.
const FALLBACK_CENTER: [number, number] = [15.274102, 48.135314];
const FALLBACK_ZOOM = 3;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MAX_MOVEMENT_PX = 10;
const USER_ACCURACY_SOURCE = 'user-accuracy';
const USER_ACCURACY_FILL_LAYER = 'user-accuracy-fill';
const ACCURACY_CIRCLE_POINTS = 64;

const router = useRouter();
const route = useRoute();
const markerStore = useMapMarkerStore();
const markerEditStore = useMarkerEditStore();
const { isDarkMode } = useDarkMode();
const pumpCalculation = usePumpCalculation();
const nearbyWaterSource = useNearbyWaterSource();
const defaultStore = useDefaultStore();
const settingsStore = useSettingsStore();
const { showZoomButtons, mapLayer, terrain3d, markerFilters } = storeToRefs(settingsStore);
const { t, locale } = useI18n();

const { isMobile } = useScreenDetection();
const { formatAddress, getFeatureName } = usePhotonSearch();
const { isOnline } = useNetworkStatus();

const isSatellite = ref(false);
const layerModalOpen = ref(false);
const layerSelectorEvent = ref<Event | undefined>(undefined);

let rootMap: maplibregl.Map | null = null;
let mapReady = false;
let styleReloadVersion = 0;
let pendingStyleLoadCallback: (() => void) | null = null;

// Markers (DOM-based MapLibre markers)
let selectedMarker: maplibregl.Marker | null = null;
let ghostMarker: maplibregl.Marker | null = null;
let userLocationMarker: maplibregl.Marker | null = null;

// Custom external location marker
let customLocationMarker: maplibregl.Marker | null = null;

// Search result marker
let searchMarker: maplibregl.Marker | null = null;

const mapCenterForSearch = ref<{ lat: number; lng: number } | undefined>(undefined);

function updateMapCenterForSearch() {
	if (!rootMap) return;
	try {
		const center = rootMap.getCenter();
		mapCenterForSearch.value = { lat: center.lat, lng: center.lng };
	} catch {
		// ignore
	}
}

function onSearchResultSelected(feature: PhotonFeature) {
	if (!rootMap) return;
	const [lng, lat] = feature.geometry.coordinates;

	// Remove previous search marker if exists
	if (searchMarker) {
		searchMarker.remove();
		searchMarker = null;
	}

	// Create new marker with popup
	searchMarker = new maplibregl.Marker()
		.setLngLat([lng, lat])
		.setPopup(
			new maplibregl.Popup({ offset: 35 }).setHTML(
				`<strong>${getFeatureName(feature)}</strong><br>${formatAddress(feature)}`
			)
		)
		.addTo(rootMap);

	// Open popup
	searchMarker.togglePopup();

	// Fly to location
	rootMap.flyTo({ center: [lng, lat], zoom: 16 });
}

function onSearchCleared() {
	if (searchMarker) {
		searchMarker.remove();
		searchMarker = null;
	}
}

function createSelectedMarker(): maplibregl.Marker {
	const el = document.createElement('img');
	el.src = selectedMarkerIconUrl;
	el.style.width = '56px';
	el.style.height = '56px';
	return new maplibregl.Marker({ element: el, anchor: 'center' });
}

function createGhostMarker(): maplibregl.Marker {
	const marker = new maplibregl.Marker({ draggable: true });
	marker.on('dragend', () => {
		const lngLat = marker.getLngLat();
		markerEditStore.pendingLocation = { lat: lngLat.lat, lng: lngLat.lng };
	});
	return marker;
}

function createUserLocationMarker(): maplibregl.Marker {
	const el = document.createElement('div');
	el.style.width = '16px';
	el.style.height = '16px';
	el.style.borderRadius = '50%';
	el.style.backgroundColor = '#136AEC';
	el.style.border = '3px solid #fff';
	el.style.boxSizing = 'content-box';
	return new maplibregl.Marker({ element: el, anchor: 'center' });
}

function getProtomapsStyle(): maplibregl.StyleSpecification {
	const lang = locale.value || 'en';
	const flavor = isSatellite.value
		? satelliteFlavor
		: isDarkMode.value
			? nightFlavor
			: outdoorsFlavor;

	const spriteFlavor = isSatellite.value ? 'light' : isDarkMode.value ? 'dark' : 'light';

	// All sources route through the `offline://` protocol (registered in main.ts)
	// so they are served cache-first from the offline tile store and fall back to
	// the network online. The TileJSON `url:` form can't work offline (its
	// metadata isn't fetchable), so every source inlines an explicit tile
	// template plus the metadata (minzoom/maxzoom/encoding/tileSize) instead.
	const sources: Record<string, maplibregl.SourceSpecification> = {
		protomaps: {
			type: 'vector',
			tiles: ['offline://protomaps/{z}/{x}/{y}'],
			minzoom: 0,
			maxzoom: 15,
			attribution:
				'&copy; <a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
		}
	};

	if (terrain3d.value) {
		// Mapterhorn DEM: terrarium-encoded, 512 px, `.webp` tiles (values inlined
		// from tiles.mapterhorn.com/tilejson.json). maxzoom 12 matches the download
		// cap; MapLibre overzooms the DEM for hillshade/terrain above that.
		const terrainSource: maplibregl.SourceSpecification = {
			type: 'raster-dem',
			tiles: ['offline://terrain/{z}/{x}/{y}'],
			encoding: 'terrarium',
			tileSize: 512,
			maxzoom: 12,
			attribution: "<a href='https://mapterhorn.com/attribution'>© Mapterhorn</a>"
		};
		sources['terrainSource'] = terrainSource;
		sources['hillshadeSource'] = terrainSource;
	}

	const baseLayers: maplibregl.LayerSpecification[] = [];

	if (isSatellite.value) {
		sources['satellite'] = {
			type: 'raster',
			tiles: ['offline://satellite/{z}/{x}/{y}'],
			tileSize: 256,
			// Display up to z19; downloads cap at z17, so 18–19 render as overzoomed
			// z17 tiles offline.
			maxzoom: 19,
			attribution: '&copy; Esri'
		};
		baseLayers.push({
			id: 'satellite-layer',
			type: 'raster',
			source: 'satellite'
		} as maplibregl.LayerSpecification);
	}

	const style: maplibregl.StyleSpecification = {
		version: 8,
		// Glyphs & sprites also go through the protocol; the assets handler resolves
		// the requested path (MapLibre appends .json/.png/@2x and encodes the
		// fontstack) against the upstream basemaps-assets host.
		glyphs: 'offline://assets/fonts/{fontstack}/{range}.pbf',
		sprite: `offline://assets/sprites/v4/${spriteFlavor}`,
		sources,
		layers: [
			...baseLayers,
			...protomapsLayers('protomaps', flavor, { lang }).map((layer) => {
				if (
					layer.type === 'symbol' &&
					(layer.id === 'roads_labels_minor' || layer.id === 'roads_labels_major')
				) {
					return { ...layer, layout: { ...layer.layout, 'text-size': 16 } };
				}
				if (layer.type === 'symbol' && layer.id === 'address_label') {
					return {
						...layer,
						minzoom: 16,
						layout: { ...layer.layout, 'text-size': 14 }
					};
				}
				return layer;
			}),
			...(terrain3d.value
				? [
						{
							id: 'hills',
							type: 'hillshade' as const,
							source: 'hillshadeSource',
							paint: { 'hillshade-shadow-color': '#473B24' }
						}
					]
				: [])
		]
	};

	if (terrain3d.value) {
		style.terrain = {
			source: 'terrainSource',
			exaggeration: 1
		};
	}

	return style;
}

function applyMapLayerSelection(selection: MapLayerSetting) {
	isSatellite.value = selection === 'satellite';
}

function syncMapStyleWithPreferences() {
	applyMapLayerSelection(mapLayer.value);

	if (rootMap && mapReady) {
		reloadMapStyle();
	}
}

const showResetView = ref(false);
const compassRotation = ref(0);

function applyTerrainSettings() {
	if (!rootMap) return;

	if (terrain3d.value) {
		rootMap.touchPitch.enable();
		rootMap.touchZoomRotate.enableRotation();
		rootMap.dragRotate.enable();
	} else {
		rootMap.touchPitch.disable();
		rootMap.touchZoomRotate.disableRotation();
		rootMap.dragRotate.disable();
		rootMap.setPitch(0);
		rootMap.setBearing(0);
	}
	updateResetViewVisibility();
}

function updateResetViewVisibility() {
	if (!rootMap) {
		showResetView.value = false;
		compassRotation.value = 0;
		return;
	}
	const pitch = rootMap.getPitch();
	const bearing = rootMap.getBearing();
	showResetView.value = pitch !== 0 || Math.abs(bearing) > 0.5;
	compassRotation.value = -bearing;
}

function resetView() {
	if (!rootMap) return;
	rootMap.easeTo({ pitch: 0, bearing: 0, duration: 300 });
}

function openLayerSelector(event: Event) {
	layerSelectorEvent.value = event;
	layerModalOpen.value = true;
}

// Save/restore map view via localStorage
function saveMapView() {
	if (!rootMap) return;
	try {
		const center = rootMap.getCenter();
		const view = { lat: center.lat, lng: center.lng, zoom: rootMap.getZoom() };
		localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view));
	} catch {
		// localStorage might be unavailable
	}
}

function restoreMapView(): { center: [number, number]; zoom: number } | null {
	try {
		const stored = localStorage.getItem(MAP_VIEW_STORAGE_KEY);
		if (stored) {
			const view = JSON.parse(stored);
			return { center: [view.lng, view.lat], zoom: view.zoom };
		}
	} catch {
		// ignore
	}
	return null;
}

// Ensure MapLibre recalculates the map size once layout is settled
async function ensureMapSize() {
	await nextTick();
	await new Promise((r) => requestAnimationFrame(() => r(undefined)));
	rootMap?.resize();
}

function getMapBounds(): GeoBounds | null {
	if (!rootMap) return null;
	const bounds = rootMap.getBounds();
	return {
		south: bounds.getSouth(),
		west: bounds.getWest(),
		north: bounds.getNorth(),
		east: bounds.getEast()
	};
}

async function handleMapMovement() {
	// do not fetch data for big zoom areas!
	if (!rootMap || rootMap.getZoom() <= 9) return;

	const bounds = getMapBounds();
	if (!bounds) {
		return;
	}

	const geojson = await getMarkersForView(bounds);
	const source = rootMap.getSource(MARKER_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
	if (source) {
		source.setData(geojson);
	}
}

//http://localhost:5173/#/?lat=48.1292912&lng=15.2728629&zoom=15&external=true

function startAdding() {
	if (rootMap) {
		const center = rootMap.getCenter();
		markerEditStore.requestStartAdding({ lat: center.lat, lng: center.lng });
	}
}

watch(
	() => markerEditStore.isActive,
	(active) => {
		if (!active && ghostMarker) {
			ghostMarker.remove();
		}
	}
);

watch(
	() => markerEditStore.pendingLocation,
	(loc) => {
		if (loc && rootMap && markerEditStore.isActive) {
			if (!ghostMarker) {
				ghostMarker = createGhostMarker();
			}
			ghostMarker.setLngLat([loc.lng, loc.lat]);
			ghostMarker.addTo(rootMap);
		}
	}
);

function fitMapToLayer() {
	if (!rootMap) return;

	const visibleMapView = defaultStore.visibleMapView;
	const defaultPadding = 16;
	const padding = {
		top: visibleMapView.top + defaultPadding,
		left: defaultPadding + visibleMapView.x,
		bottom: visibleMapView.yMax - visibleMapView.y,
		right: defaultPadding
	};

	if (pumpCalculation.isActive.value && pumpCalculation.hasPolyline()) {
		const bounds = pumpCalculation.getPolylineBounds();
		if (bounds) {
			rootMap.fitBounds(bounds, { padding });
		}
	} else if (selectedPathVisible.value && selectedPathCoords.value.length >= 2) {
		const bounds = new maplibregl.LngLatBounds();
		selectedPathCoords.value.forEach((coord) => bounds.extend(coord as [number, number]));
		// maxZoom keeps very short paths from zooming in to house-number level.
		rootMap.fitBounds(bounds, { padding, maxZoom: 17 });
	} else {
		// Center on the ghost marker (editing) or the selected marker
		const marker = markerEditStore.isActive ? ghostMarker : selectedMarker;
		if (marker) {
			const centerOffsetX = (padding.left - padding.right) / 2;
			const centerOffsetY = (padding.top - padding.bottom) / 2;

			const markerLngLat = marker.getLngLat();
			const markerPoint = rootMap.project(markerLngLat);

			const adjustedPoint = new maplibregl.Point(
				markerPoint.x - centerOffsetX,
				markerPoint.y - centerOffsetY
			);

			const adjustedLngLat = rootMap.unproject(adjustedPoint);
			rootMap.panTo(adjustedLngLat);
		}
	}
}

// Selected path state
const selectedPathCoords = ref<[number, number][]>([]);
const selectedPathVisible = ref(false);
// Length of the displayed path (routed or straight), rendered as a label on the line.
const selectedPathDistanceText = ref('');
const pumpCalculationStore = usePumpCalculationStore();

function formatPathDistance(meters: number): string {
	const distance = meters < 1000 ? `${Math.round(meters)}m` : `${(meters / 1000).toFixed(1)}km`;
	const tubes = Math.ceil(meters / pumpCalculationStore.tubeLength);
	return `${distance} · ~${tubes} ${pumpCalculationStore.hoseName}-${t('pumpCalculation.pump.tubes')}`;
}

/** Point halfway along the polyline (by length) — anchors the distance label. */
function pathMidpoint(coords: [number, number][]): [number, number] {
	let total = 0;
	const segment: number[] = [];
	for (let i = 0; i < coords.length - 1; i++) {
		const len = distanceTo(
			{ lng: coords[i][0], lat: coords[i][1] },
			{ lng: coords[i + 1][0], lat: coords[i + 1][1] }
		);
		segment.push(len);
		total += len;
	}
	let remaining = total / 2;
	for (let i = 0; i < segment.length; i++) {
		if (remaining <= segment[i]) {
			const f = segment[i] === 0 ? 0 : remaining / segment[i];
			return [
				coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f,
				coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f
			];
		}
		remaining -= segment[i];
	}
	return coords[coords.length - 1];
}

/**
 * The path line plus a midpoint anchor for the label. The label sits on a
 * point symbol (not line-center placement): line-center labels are dropped
 * whenever the text doesn't fit along the rendered line, so short or sharply
 * bent paths would intermittently lose their distance text.
 */
function selectedPathFeatures(): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [
		{
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: selectedPathCoords.value },
			properties: {}
		}
	];
	if (selectedPathCoords.value.length >= 2) {
		features.push({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: pathMidpoint(selectedPathCoords.value) },
			properties: { distanceText: selectedPathDistanceText.value }
		});
	}
	return { type: 'FeatureCollection', features };
}

function setSelectedPathVisibility(visible: boolean) {
	if (!rootMap) return;
	const visibility = visible ? 'visible' : 'none';
	for (const layer of [SELECTED_PATH_LAYER, SELECTED_PATH_LABEL_LAYER]) {
		if (rootMap.getLayer(layer)) {
			rootMap.setLayoutProperty(layer, 'visibility', visibility);
		}
	}
}

function updateSelectedPath(points: GeoPoint[]) {
	selectedPathCoords.value = points.map((p) => [p.lng, p.lat] as [number, number]);
	let pathLengthM = 0;
	for (let i = 0; i < points.length - 1; i++) {
		pathLengthM += distanceTo(points[i], points[i + 1]);
	}
	selectedPathDistanceText.value = formatPathDistance(pathLengthM);
	selectedPathVisible.value = true;

	if (rootMap && mapReady) {
		const source = rootMap.getSource(SELECTED_PATH_SOURCE) as maplibregl.GeoJSONSource;
		if (source) {
			source.setData(selectedPathFeatures());
		}
		setSelectedPathVisibility(true);
	}
}

function hideSelectedPath() {
	selectedPathVisible.value = false;
	selectedPathCoords.value = [];
	if (rootMap && mapReady) {
		setSelectedPathVisibility(false);
	}
}

function restoreSelectedPath() {
	if (!rootMap || !selectedPathVisible.value || selectedPathCoords.value.length < 2) return;

	const source = rootMap.getSource(SELECTED_PATH_SOURCE) as maplibregl.GeoJSONSource;
	if (source) {
		source.setData(selectedPathFeatures());
	}
	setSelectedPathVisibility(true);
}

function restoreDomMarkers() {
	if (!rootMap) return;

	// Re-add selected marker
	if (selectedMarker && markerStore.selectedMarker) {
		selectedMarker.addTo(rootMap);
	}

	// Re-add ghost marker (editing mode)
	if (ghostMarker && markerEditStore.isActive) {
		ghostMarker.addTo(rootMap);
	}

	// Re-add user location marker
	if (userLocationMarker && currentUserLocation.value) {
		userLocationMarker.addTo(rootMap);
	}

	// Re-add custom location marker
	if (customLocationMarker) {
		customLocationMarker.addTo(rootMap);
	}
}

watch(defaultStore.visibleMapView, fitMapToLayer);
watch(pumpCalculation.calculationResult, (val) => {
	if (val) {
		fitMapToLayer();
	}
});

const debouncedMapMove = debounce(handleMapMovement, MOVE_DEBOUNCE_MS);

// ---------------------------------------------------------------------------
// Fetch-error toast (§1.5)
// Show once when a foreground fetch fails; include a Retry button.
// A module-level ref prevents duplicate toasts from stacking.
// ---------------------------------------------------------------------------

let activeFetchErrorToast: HTMLIonToastElement | null = null;

async function showFetchErrorToast() {
	if (activeFetchErrorToast) return; // already showing — don't stack
	activeFetchErrorToast = await toastController.create({
		message: t('network.fetchFailed'),
		duration: 6000,
		buttons: [
			{
				text: t('network.retry'),
				handler: () => {
					handleMapMovement();
				}
			}
		]
	});
	activeFetchErrorToast.onDidDismiss().then(() => {
		activeFetchErrorToast = null;
	});
	await activeFetchErrorToast.present();
}

watch(markerFetchFailed, (failed) => {
	if (failed) {
		showFetchErrorToast();
	}
});

// Guards against stale async results: the function is fired from a watcher
// without await, and only the newest selection may draw its path.
let pathRequestSeq = 0;

const showPathToSelectedMarker = async () => {
	if (!selectedMarker) return;
	const inNearbyMode = nearbyWaterSource.isActive.value;
	const requestId = ++pathRequestSeq;
	// Outside the nearby view the map-center fallback would draw a confusing
	// line out of the screen center, so a real user location is required there.
	const currentLocation = inNearbyMode ? await getCurrentLocation() : currentUserLocation.value;
	if (!currentLocation) {
		hideSelectedPath();
		return;
	}
	const markerLngLat = selectedMarker.getLngLat();
	const target: GeoPoint = { lat: markerLngLat.lat, lng: markerLngLat.lng };
	// Prefer the routed path; fall back to the straight line.
	const routed = await getRoutedPath(currentLocation, target, {
		clampToRoads: settingsStore.clampHosesToRoads
	});
	if (requestId !== pathRequestSeq) return;
	const points = routed && routed.length >= 2 ? routed : [currentLocation, target];
	updateSelectedPath(points);
	// Only the nearby view refits the camera to the path; a plain marker tap
	// keeps its usual fly-to/centering behavior and just shows the line.
	if (inNearbyMode) {
		fitMapToLayer();
	}
};

let isFirstWatch = true;
// Watch store's selectedMarker and update map display
watch(
	() => markerStore.selectedMarker,
	(marker) => {
		if (!marker) {
			// Remove marker from map if no selection
			if (selectedMarker) {
				selectedMarker.remove();
				selectedMarker = null;
			}
			hideSelectedPath();
			return;
		}

		try {
			const lat = marker.lat || marker.center?.lat || 0;
			const lng = marker.lon || marker.center?.lon || 0;

			if (!selectedMarker) {
				selectedMarker = createSelectedMarker();
			}
			selectedMarker.setLngLat([lng, lat]);
			if (rootMap) {
				selectedMarker.addTo(rootMap);
			}

			showPathToSelectedMarker();
			if (!nearbyWaterSource.isActive.value) {
				if (isFirstWatch && rootMap) {
					rootMap.flyTo({ center: [lng, lat], zoom: DISABLE_CLUSTERING_ZOOM });
				} else {
					fitMapToLayer();
				}
			}
		} catch (e) {
			console.error(e);
		} finally {
			isFirstWatch = false;
		}
	}
);

// Location tracking
const watchId = ref<string | null>(null);
const currentUserLocation = ref<GeoPoint | null>(null);
const currentUserAccuracy = ref<number | null>(null);
const waitingForLocation = ref(false);

/** Build an approximate circle polygon (lon/lat degrees) for a given accuracy radius in metres. */
function generateAccuracyCircle(
	lat: number,
	lng: number,
	accuracyMeters: number
): GeoJSON.Feature<GeoJSON.Polygon> {
	// Same lat/lng-delta math as getNearbyMapNodes in databaseHandler.ts
	const latDelta = accuracyMeters / 111320;
	const lngDelta = accuracyMeters / (111320 * Math.cos((lat * Math.PI) / 180));
	const coords: [number, number][] = [];
	for (let i = 0; i <= ACCURACY_CIRCLE_POINTS; i++) {
		const angle = (i * 2 * Math.PI) / ACCURACY_CIRCLE_POINTS;
		coords.push([lng + lngDelta * Math.cos(angle), lat + latDelta * Math.sin(angle)]);
	}
	return {
		type: 'Feature',
		geometry: { type: 'Polygon', coordinates: [coords] },
		properties: {}
	};
}

/** Push the current accuracy circle geometry to the map source (or clear it when unavailable). */
function updateAccuracyCircle() {
	if (!rootMap) return;
	const source = rootMap.getSource(USER_ACCURACY_SOURCE) as maplibregl.GeoJSONSource | undefined;
	if (!source) return;
	if (currentUserLocation.value !== null && currentUserAccuracy.value !== null) {
		source.setData(
			generateAccuracyCircle(
				currentUserLocation.value.lat,
				currentUserLocation.value.lng,
				currentUserAccuracy.value
			)
		);
	} else {
		source.setData({ type: 'FeatureCollection', features: [] });
	}
}

/** True when location permission is already granted (never prompts). */
async function hasLocationPermission(): Promise<boolean> {
	try {
		const status = await Geolocation.checkPermissions();
		return status.location === 'granted' || status.coarseLocation === 'granted';
	} catch {
		// Permissions API unsupported (some web browsers) → treat as not granted.
		return false;
	}
}

/**
 * Fetches the current fix, updates the location marker, and starts watching it.
 *
 * @param promptIfNeeded When `true` (default, the location-FAB path) requests
 *   permission if not yet granted. When `false` (silent startup path) it only
 *   proceeds if permission is already granted, so app launch never triggers an
 *   uninvited permission prompt. Returns `null` when permission is unavailable.
 */
async function acquireCurrentLocation(promptIfNeeded = true): Promise<GeoPoint | null> {
	if (Capacitor.isNativePlatform()) {
		// Check if we have permission
		const permission = await Geolocation.checkPermissions();

		if (permission.location !== 'granted') {
			if (!promptIfNeeded) return null;
			const requestResult = await Geolocation.requestPermissions();
			if (requestResult.location !== 'granted') {
				console.warn('Location permission not granted');
				return null;
			}
		}
	} else if (!promptIfNeeded && !(await hasLocationPermission())) {
		// Web silent path: only proceed on an existing grant so page load never
		// pops the browser's geolocation prompt.
		return null;
	}

	// Get current position
	const position = await Geolocation.getCurrentPosition({
		enableHighAccuracy: true,
		timeout: 10000,
		maximumAge: 0
	});

	const point: GeoPoint = {
		lat: position.coords.latitude,
		lng: position.coords.longitude
	};
	currentUserLocation.value = point;
	currentUserAccuracy.value = position.coords.accuracy ?? null;

	// Update or create location marker
	updateLocationMarker(point);

	startWatchingLocation();

	return point;
}

async function showUserLocation() {
	try {
		if (!watchId.value) {
			waitingForLocation.value = true;
			const point = await acquireCurrentLocation();
			waitingForLocation.value = false;
			if (!point) return;
		}

		// Fly to user location
		if (rootMap && userLocationMarker) {
			const lngLat = userLocationMarker.getLngLat();
			rootMap.flyTo({
				center: lngLat,
				zoom: Math.max(rootMap.getZoom(), DISABLE_CLUSTERING_ZOOM)
			});
		}
	} catch (error) {
		console.error('Error getting location:', error);
		waitingForLocation.value = false;
	}
}

/**
 * Startup location handling. If permission is already granted, silently
 * activate the user location (dot + tracking) without prompting. On a fresh
 * install (no saved view — map sits at the low-zoom placeholder so no Overpass
 * fetch fires) jump straight to the resolved location.
 *
 * When the location is unavailable (permission not granted, denied, or timed
 * out) nothing happens: the map stays at the low-zoom placeholder (fresh
 * install) or the restored saved view (returning user). We deliberately do NOT
 * zoom into the hardcoded default region — the user can zoom in themselves.
 *
 * @param recenterOnFreshInstall When `false` (a deep link / external location
 *   is driving the camera) the location is still activated but the camera is
 *   left alone.
 */
async function activateLocationOnStartup(recenterOnFreshInstall: boolean) {
	let point: GeoPoint | null = null;
	try {
		point = await acquireCurrentLocation(false);
	} catch (error) {
		console.warn('Could not determine initial device location:', error);
	}

	if (!point || !recenterOnFreshInstall || !rootMap) return;
	// A marker deep-link or a user interaction during the (up to 10s) async
	// geolocation wait takes precedence — don't yank the camera away from it.
	if (markerStore.selectedMarker || rootMap.getZoom() > FALLBACK_ZOOM) return;

	rootMap.jumpTo({ center: [point.lng, point.lat], zoom: DISABLE_CLUSTERING_ZOOM });
}

function updateLocationMarker(point: GeoPoint) {
	if (!rootMap) return;

	// Update or create location marker
	if (!userLocationMarker) {
		userLocationMarker = createUserLocationMarker();
	}
	userLocationMarker.setLngLat([point.lng, point.lat]);
	userLocationMarker.addTo(rootMap);

	// Keep the accuracy circle in sync with the new position/accuracy
	updateAccuracyCircle();

	// Trigger nearby search if active
	searchNearbyMarkers();
}

function startWatchingLocation() {
	Geolocation.watchPosition(
		{
			enableHighAccuracy: true,
			timeout: 10000,
			maximumAge: 0
		},
		(position, err) => {
			if (err) {
				console.error('Error watching location:', err);
				return;
			}

			if (position) {
				const point: GeoPoint = {
					lat: position.coords.latitude,
					lng: position.coords.longitude
				};
				currentUserLocation.value = point;
				currentUserAccuracy.value = position.coords.accuracy ?? null;
				updateLocationMarker(point);
			}
		}
	).then((id) => {
		watchId.value = id;
	});
}

function stopWatchingLocation() {
	if (watchId.value) {
		Geolocation.clearWatch({ id: watchId.value });
		watchId.value = null;
		waitingForLocation.value = false;
	}
}

async function getCurrentLocation(): Promise<GeoPoint> {
	// if a custom location is active, use it to find the nearest water source
	if (customLocationMarker) {
		const lngLat = customLocationMarker.getLngLat();
		return { lat: lngLat.lat, lng: lngLat.lng };
	}

	if (currentUserLocation.value) {
		return currentUserLocation.value;
	} else {
		await showUserLocation();
	}

	// Fallback to map center
	const center = rootMap!.getCenter();
	return { lat: center.lat, lng: center.lng };
}

async function searchNearbyMarkers() {
	if (!nearbyWaterSource.isActive.value) {
		return;
	}
	const location = await getCurrentLocation();
	if (!location) {
		return;
	}
	nearbyWaterSource.list.value = await getNearbyMarkers(location);
	await showPathToSelectedMarker();
}

async function loadMarkerImages(map: maplibregl.Map) {
	const entries = Object.entries(markerIconUrls);
	for (const [name, url] of entries) {
		if (map.hasImage(name)) continue;
		try {
			const response = await map.loadImage(url);
			if (!map.hasImage(name)) {
				map.addImage(name, response.data);
			}
		} catch (e) {
			// Image may have been added by a concurrent style reload
			console.warn(`Failed to load marker image "${name}":`, e);
		}
	}
}

function addMapLayers(map: maplibregl.Map) {
	// GPS accuracy circle — added first so it renders below all marker layers.
	// DOM markers (the location dot) are always above GL layers automatically.
	// The fill layer is not included in interactiveLayers, so it never captures clicks.
	map.addSource(USER_ACCURACY_SOURCE, {
		type: 'geojson',
		data: { type: 'FeatureCollection', features: [] }
	});
	map.addLayer({
		id: USER_ACCURACY_FILL_LAYER,
		type: 'fill',
		source: USER_ACCURACY_SOURCE,
		paint: {
			'fill-color': 'rgba(19, 106, 236, 0.15)',
			'fill-outline-color': 'rgba(19, 106, 236, 0.4)'
		}
	});

	// Marker source with clustering
	map.addSource(MARKER_SOURCE_ID, {
		type: 'geojson',
		data: { type: 'FeatureCollection', features: [] },
		cluster: true,
		clusterMaxZoom: DISABLE_CLUSTERING_ZOOM - 1,
		clusterRadius: CLUSTER_RADIUS
	});

	// Cluster circles
	map.addLayer({
		id: 'clusters',
		type: 'circle',
		source: MARKER_SOURCE_ID,
		filter: ['has', 'point_count'],
		paint: {
			'circle-color': ['step', ['get', 'point_count'], '#51bbd6', 100, '#f1f075', 750, '#f28cb1'],
			'circle-radius': ['step', ['get', 'point_count'], 20, 100, 30, 750, 40]
		}
	});

	// Cluster count labels
	map.addLayer({
		id: 'cluster-count',
		type: 'symbol',
		source: MARKER_SOURCE_ID,
		filter: ['has', 'point_count'],
		layout: {
			'text-field': '{point_count_abbreviated}',
			'text-font': ['Noto Sans Medium'],
			'text-size': 12
		}
	});

	// Individual markers (unclustered)
	map.addLayer({
		id: 'unclustered-point',
		type: 'symbol',
		source: MARKER_SOURCE_ID,
		filter: ['!', ['has', 'point_count']],
		layout: {
			'icon-image': ['get', 'icon'],
			'icon-size': 0.25,
			'icon-allow-overlap': true
		}
	});

	// Selected path line source and layer
	map.addSource(SELECTED_PATH_SOURCE, {
		type: 'geojson',
		// Holds the path LineString plus a midpoint Point anchoring the label.
		data: { type: 'FeatureCollection', features: [] }
	});

	map.addLayer({
		id: SELECTED_PATH_LAYER,
		type: 'line',
		source: SELECTED_PATH_SOURCE,
		layout: { visibility: 'none' },
		paint: {
			'line-color': '#3388ff',
			'line-width': 3
		}
	});

	// Distance label rendered along the selected path line.
	map.addLayer({
		id: SELECTED_PATH_LABEL_LAYER,
		type: 'symbol',
		source: SELECTED_PATH_SOURCE,
		// Anchored to the midpoint Point feature: a point symbol always renders,
		// while 'line-center' placement drops the label whenever the text doesn't
		// fit along the rendered line (short or sharply bent paths).
		filter: ['==', ['geometry-type'], 'Point'],
		layout: {
			visibility: 'none',
			'text-field': ['get', 'distanceText'],
			'text-font': ['Noto Sans Medium'],
			'text-size': 13,
			'text-offset': [0, -0.9],
			// The single label must always render, even over other symbols.
			'text-allow-overlap': true,
			'text-ignore-placement': true
		},
		paint: {
			'text-color': '#3388ff',
			'text-halo-color': '#ffffff',
			'text-halo-width': 2
		}
	});

	pumpCalculation.setMap(map);
}

function setupMapEventListeners(map: maplibregl.Map) {
	// -----------------------------------------------------------------------
	// Touch long-press → add marker at the pressed location (§3.4)
	// Uses MapLibre touch events so we can read the lngLat directly.
	// Guards:
	//   • Only single-finger touch (multi-touch = pinch/zoom → ignore)
	//   • Not while edit is already active
	//   • Not on the supply-pipe route (that route uses `contextmenu` for its
	//     own marker placement; MapLibre also emits `contextmenu` for touch
	//     long-press on mobile — by skipping the timer here we ensure the two
	//     handlers never fire simultaneously on that route)
	// -----------------------------------------------------------------------
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressLngLat: maplibregl.LngLat | null = null;
	let longPressStartPixel: { x: number; y: number } | null = null;

	function cancelLongPress() {
		if (longPressTimer !== null) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		longPressLngLat = null;
		longPressStartPixel = null;
	}

	map.on('touchstart', (e: maplibregl.MapTouchEvent) => {
		cancelLongPress(); // clear any previous timer
		if (markerEditStore.isActive) return;
		if (route.path.includes('supplypipe')) return;
		if (e.originalEvent.touches.length !== 1) return;

		const touch = e.originalEvent.touches[0];
		longPressStartPixel = { x: touch.clientX, y: touch.clientY };
		longPressLngLat = e.lngLat;

		longPressTimer = setTimeout(() => {
			if (longPressLngLat) {
				markerEditStore.requestStartAdding({
					lat: longPressLngLat.lat,
					lng: longPressLngLat.lng
				});
			}
			cancelLongPress();
		}, LONG_PRESS_MS);
	});

	map.on('touchmove', (e: maplibregl.MapTouchEvent) => {
		if (longPressTimer === null || !longPressStartPixel) return;
		const touch = e.originalEvent.changedTouches[0] ?? e.originalEvent.touches[0];
		if (!touch) {
			cancelLongPress();
			return;
		}
		const dx = touch.clientX - longPressStartPixel.x;
		const dy = touch.clientY - longPressStartPixel.y;
		if (Math.hypot(dx, dy) > LONG_PRESS_MAX_MOVEMENT_PX) {
			cancelLongPress();
		}
	});

	map.on('touchend', cancelLongPress);
	map.on('touchcancel', cancelLongPress);

	// Cancel on any map-driven movement (drag pan or zoom animation)
	map.on('move', () => {
		if (longPressTimer !== null) {
			cancelLongPress();
		}
	});

	// General map click handler
	map.on('click', async (e) => {
		// Check if click was on a marker or cluster
		const interactiveLayers = ['clusters', 'unclustered-point'];
		const features = map.queryRenderedFeatures(e.point, { layers: interactiveLayers });

		if (features.length > 0) {
			const feature = features[0];

			// Cluster click → zoom in
			if (feature.properties?.cluster_id !== undefined) {
				const source = map.getSource(MARKER_SOURCE_ID) as maplibregl.GeoJSONSource;
				const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
				try {
					const expansionZoom = await source.getClusterExpansionZoom(feature.properties.cluster_id);
					const zoom = Math.max(expansionZoom, map.getZoom() + 1);
					map.easeTo({ center: coords, zoom });
				} catch {
					map.easeTo({ center: coords, zoom: (map.getZoom() || 10) + 2 });
				}
				return;
			}

			// Individual marker click
			if (markerEditStore.isActive) {
				// In edit mode, clicking a marker updates pending location
				markerEditStore.pendingLocation = { lat: e.lngLat.lat, lng: e.lngLat.lng };
				return;
			}

			// While the supply pipe calculation is active, tapping a water
			// source offers it as the suction point (hydrant pressure and all)
			// instead of navigating to the marker.
			if (route.path.includes('supplypipe')) {
				const tappedId = feature.properties?.id;
				if (tappedId) {
					const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
					pumpCalculation.useMarkerAsWaterSource(Number(tappedId), {
						lat: coords[1],
						lng: coords[0]
					});
				}
				return;
			}

			const markerId = feature.properties?.id;
			if (markerId) {
				router.push(`/markers/${markerId}`);
			}
			return;
		}

		// Click on empty map area
		if (markerEditStore.isActive) {
			markerEditStore.pendingLocation = { lat: e.lngLat.lat, lng: e.lngLat.lng };
			return;
		}

		// do not close if the supply pipe is open
		if (route.path.includes('supplypipe')) {
			return;
		}

		const hideLocationMarker =
			!route.path.includes('/markers/') && !route.path.includes('/nearbysources');

		// The marker should only be hidden after tapping on the map and no marker info panel is open.
		if (hideLocationMarker && customLocationMarker) {
			customLocationMarker.remove();
			customLocationMarker = null;
		}

		router.replace('/');
	});

	// Context menu
	map.on('contextmenu', (e) => {
		if (route.path.includes('supplypipe')) {
			pumpCalculation.markerSetAlert({ lat: e.lngLat.lat, lng: e.lngLat.lng });
		}
	});

	// Cursor changes for interactive layers
	map.on('mouseenter', 'unclustered-point', () => {
		map.getCanvas().style.cursor = 'pointer';
	});
	map.on('mouseleave', 'unclustered-point', () => {
		map.getCanvas().style.cursor = '';
	});
	map.on('mouseenter', 'clusters', () => {
		map.getCanvas().style.cursor = 'pointer';
	});
	map.on('mouseleave', 'clusters', () => {
		map.getCanvas().style.cursor = '';
	});

	// Save view on movement
	map.on('moveend', saveMapView);
}

async function initMap() {
	await nextTick();

	// Check if map already exists and remove it
	if (rootMap) {
		rootMap.remove();
		rootMap = null;
	}

	mapReady = false;

	const savedView = restoreMapView();
	applyMapLayerSelection(mapLayer.value);

	rootMap = new maplibregl.Map({
		container: MAP_ELEMENT_ID,
		style: getProtomapsStyle(),
		center: savedView?.center || FALLBACK_CENTER,
		zoom: savedView?.zoom ?? FALLBACK_ZOOM,
		maxZoom: 19,
		dragRotate: true,
		touchZoomRotate: true,
		pitchWithRotate: true,
		pitch: 0,
		maxPitch: 75
	});

	// Important: force MapLibre to recalc size after layout is ready
	await ensureMapSize();

	rootMap.on('load', async () => {
		if (!rootMap) return;
		mapReady = true;

		await loadMarkerImages(rootMap);
		addMapLayers(rootMap);
		setupMapEventListeners(rootMap);
		applyTerrainSettings();
		handleMapMovement();

		// Set initial map center for search bias and keep it updated on movement
		updateMapCenterForSearch();
		rootMap.on('moveend', updateMapCenterForSearch);

		// moveend already fires after dragend, zoomend, flyTo, easeTo, etc.
		// Using only moveend avoids duplicate handler invocations per interaction.
		rootMap.on('moveend', debouncedMapMove);

		rootMap.on('pitchend', updateResetViewVisibility);
		rootMap.on('rotateend', updateResetViewVisibility);
		rootMap.on('moveend', updateResetViewVisibility);

		watchExternalLocationQuery();

		// Activate the user location on startup when permission is already
		// granted. Recenter to it only on a fresh install (no saved view) that
		// isn't being driven to a specific marker or external location — so the
		// startup jump never fights that camera move. A returning user keeps
		// their restored view; if location is unavailable the map stays at the
		// low-zoom placeholder (no fetch, no jump to the hardcoded default).
		const hasExternalLocation =
			route.query.external === 'true' && route.query.lat && route.query.lng;
		const recenterOnFreshInstall = !savedView && !hasExternalLocation && !route.params.markerId;
		activateLocationOnStartup(recenterOnFreshInstall);
	});
}

function watchExternalLocationQuery() {
	watch(
		() => route.query,
		(query) => {
			if (query.external === 'true' && query.lat && query.lng && query.zoom && rootMap) {
				const lat = parseFloat(query.lat as string);
				const lng = parseFloat(query.lng as string);
				const zoom = parseFloat(query.zoom as string);

				if (customLocationMarker) {
					customLocationMarker.setLngLat([lng, lat]);
				} else {
					customLocationMarker = new maplibregl.Marker().setLngLat([lng, lat]).addTo(rootMap);
				}
				rootMap.setCenter([lng, lat]);
				rootMap.setZoom(zoom);
			}
		},
		{ immediate: true }
	);
}

function reloadMapStyle() {
	if (!rootMap || !mapReady) return;
	const currentVersion = ++styleReloadVersion;

	// Remove any previously registered style.load handler to prevent stale callbacks
	if (pendingStyleLoadCallback) {
		rootMap.off('style.load', pendingStyleLoadCallback);
		pendingStyleLoadCallback = null;
	}

	const onStyleLoad = async () => {
		pendingStyleLoadCallback = null;
		if (!rootMap || currentVersion !== styleReloadVersion) return;

		await loadMarkerImages(rootMap);
		addMapLayers(rootMap);
		handleMapMovement();
		applyTerrainSettings();

		// Restore selected path if it was visible
		restoreSelectedPath();

		// Re-add DOM markers that may have been detached
		restoreDomMarkers();

		// Restore accuracy circle data (addMapLayers seeded the source with empty data)
		updateAccuracyCircle();

		// Restore pump calculation markers and polyline
		pumpCalculation.restoreMapState(rootMap);
	};

	pendingStyleLoadCallback = onStyleLoad;
	rootMap.once('style.load', onStyleLoad);
	rootMap.setStyle(getProtomapsStyle());
}
function zoomIn() {
	rootMap?.zoomIn();
}

function zoomOut() {
	rootMap?.zoomOut();
}

onMounted(async () => {
	await nextTick();
	await initMap();

	// Watch route params and update store
	watch(
		() => route.params.markerId,
		async (markerId) => {
			const markerIdNumber = markerId ? Number(markerId) : null;
			await markerStore.selectMarker(markerIdNumber);
		},
		{ immediate: true }
	);

	watch(
		() => route.path,
		async (path, prevPath) => {
			if (path.includes('nearbysources') && !prevPath?.includes('nearbysources')) {
				await searchNearbyMarkers();
			} else if (!path.includes('nearbysources')) {
				nearbyWaterSource.list.value = [];
			}
		},
		{ immediate: true }
	);

	watch(
		() => mapLayer.value,
		() => {
			syncMapStyleWithPreferences();
			// If map isn't ready yet, queue the style sync for after load
			if (rootMap && !mapReady) {
				rootMap.once('load', () => {
					syncMapStyleWithPreferences();
				});
			}
		}
	);

	watch(isDarkMode, () => {
		if (!isSatellite.value) {
			syncMapStyleWithPreferences();
		}
	});

	watch(locale, () => {
		reloadMapStyle();
	});

	watch(terrain3d, () => {
		syncMapStyleWithPreferences();
	});

	watch(
		markerFilters,
		() => {
			if (mapReady) handleMapMovement();
		},
		{ deep: true }
	);
});

onUnmounted(() => {
	stopWatchingLocation();
	if (rootMap) {
		rootMap.remove();
		rootMap = null;
	}
});
</script>
<style scoped>
ion-fab {
	z-index: 1000;
}

.marker-loading-indicator {
	position: absolute;
	bottom: calc(var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 8px);
	left: 24px;
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border-radius: 50%;
	background: var(--md-sys-surface-container);
	box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}

.marker-loading-indicator ion-spinner {
	width: 20px;
	height: 20px;
}

.fab-vertical-top {
	margin-top: var(--ion-safe-area-top, env(safe-area-inset-top, 0px));
}

.fab-vertical-bottom {
	margin-bottom: calc(var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 30px);
}

.zoom-fab {
	/* Move the FAB up to not overlap with the bottom FABs if the screen is small */
	transform: translateY(-50%);
	top: 50%;
	right: 0;
	/* Reset margins for center-positioned FAB */
	margin-top: 0;
	margin-bottom: 0;
}

.location-fab {
	/* Position above the other bottom FAB (56px FAB height + 16px spacing) */
	margin-bottom: calc(var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 56px + 46px);
}

.add-hydrant-fab {
	margin-bottom: calc(var(--ion-safe-area-bottom, 0) + (56px + 30px) * 2);
}

.layers-fab {
	margin-top: calc(var(--ion-safe-area-top, 0) + (40px + 16px));
	transition: margin-top 0.2s ease;
}

/* AddressSearchBar's offline hint attaches below the search bar and can
   wrap to two lines — push the layers FAB further down so it doesn't sit
   under it. */
.layers-fab-offline {
	margin-top: calc(var(--ion-safe-area-top, 0) + (40px + 16px) + 64px);
}

:deep(.maplibregl-ctrl-bottom-left),
:deep(.maplibregl-ctrl-bottom-right) {
	margin-bottom: var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px));
}

.compass-fab {
	margin-top: calc(var(--ion-safe-area-top, 0) + (40px + 16px));
}

/* MapLibre popup styling aligned with the search UI theme */
:deep(.maplibregl-popup) {
	max-width: min(320px, calc(100vw - 32px));
}

:deep(.maplibregl-popup-content) {
	background: var(--md-sys-surface-container-lowest);
	color: var(--md-sys-on-surface);
	border-radius: var(--md-sys-corner-medium);
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24);
	padding: 12px 14px;
	font-size: 14px;
	line-height: 1.4;
}

:deep(.maplibregl-popup-tip) {
	border-top-color: var(--md-sys-surface-container-lowest);
	border-bottom-color: var(--md-sys-surface-container-lowest);
}

:deep(.maplibregl-popup-close-button) {
	color: var(--md-sys-on-surface);
	font-size: 20px;
	width: 28px;
	height: 28px;
	line-height: 28px;
	border-radius: 50%;
	top: 4px;
	right: 4px;
}

:deep(.maplibregl-popup-close-button:hover) {
	background: rgba(0, 0, 0, 0.08);
}

:deep(.maplibregl-popup-content strong) {
	font-weight: 600;
	color: var(--md-sys-on-surface);
}

:deep(.maplibregl-popup-content a) {
	color: var(--md-sys-primary);
}

:deep(.darkMap .maplibregl-popup-content),
.darkMap :deep(.maplibregl-popup-content) {
	background: var(--md-sys-surface-container-lowest);
	color: var(--md-sys-on-surface);
}

:deep(.darkMap .maplibregl-popup-tip),
.darkMap :deep(.maplibregl-popup-tip) {
	border-top-color: var(--md-sys-surface-container-lowest);
	border-bottom-color: var(--md-sys-surface-container-lowest);
}

:deep(.darkMap .maplibregl-popup-close-button:hover),
.darkMap :deep(.maplibregl-popup-close-button:hover) {
	background: rgba(255, 255, 255, 0.08);
}
</style>

<style>
.darkMap {
	#map {
		background: #424d5c;
	}
}
</style>
