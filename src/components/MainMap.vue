<template>
	<div :class="{ darkMap: isDarkMode && !isSatellite }" style="height: 100%; width: 100%">
		<div id="map" style="height: 100%; width: 100%"></div>
		<!-- About FAB Button -->
		<ion-fab vertical="top" horizontal="start" slot="fixed">
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
		<ion-fab class="layers-fab" vertical="top" horizontal="start" slot="fixed">
			<ion-fab-button
				class="md-small"
				color="light"
				size="small"
				@click="openLayerSelector"
				:title="$t('about.openInfo')"
			>
				<ion-icon :icon="layers"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<!-- Settings FAB Button -->
		<ion-fab vertical="top" horizontal="end" slot="fixed">
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
		<LayerSelectorModal :is-open="layerModalOpen" @update:is-open="layerModalOpen = $event" />
	</div>
</template>
<script lang="ts" setup>
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers as protomapsLayers } from '@protomaps/basemaps';
import selectedMarkerIconUrl from '../assets/markers/selectedmarker.png';
import { nextTick, onMounted, watch, ref, onUnmounted } from 'vue';
import { debounce } from '@/helper/helper';
import { getMarkersForView, getNearbyMarkers, markerIconUrls } from '@/mapHandler/markerHandler';
import { useRoute, useRouter } from 'vue-router';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { useDarkMode } from '@/composable/darkModeDetection';
import { IonFab, IonFabButton, IonIcon, IonSpinner } from '@ionic/vue';
import LayerSelectorModal from '@/components/LayerSelectorModal.vue';
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
import { GeoPoint, GeoBounds } from '@/types/geo';
import { outdoorsFlavor } from '@/map/outdoorsFlavor';
import { nightFlavor } from '@/map/nightFlavor';
import { satelliteFlavor } from '@/map/satelliteFlavor';

const MAP_ELEMENT_ID = 'map';
const MOVE_DEBOUNCE_MS = 200;
const DISABLE_CLUSTERING_ZOOM = 15;
const MARKER_SOURCE_ID = 'markers';
const SELECTED_PATH_SOURCE = 'selected-path';
const SELECTED_PATH_LAYER = 'selected-path-layer';
const MAP_VIEW_STORAGE_KEY = 'mapView';

const router = useRouter();
const route = useRoute();
const markerStore = useMapMarkerStore();
const markerEditStore = useMarkerEditStore();
const { isDarkMode } = useDarkMode();
const pumpCalculation = usePumpCalculation();
const nearbyWaterSource = useNearbyWaterSource();
const defaultStore = useDefaultStore();
const settingsStore = useSettingsStore();
const { showZoomButtons, mapLayer, terrain3d } = storeToRefs(settingsStore);
const { t, locale } = useI18n();

const isSatellite = ref(false);
const layerModalOpen = ref(false);

const PROTOMAPS_API_KEY = '111410f5c74ab4c7';

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

	const sources: Record<string, maplibregl.SourceSpecification> = {
		protomaps: {
			type: 'vector',
			url: `https://api.protomaps.com/tiles/v4.json?key=${PROTOMAPS_API_KEY}`,
			attribution:
				'&copy; <a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
		}
	};

	if (terrain3d.value) {
		sources['terrainSource'] = {
			type: 'raster-dem',
			url: 'https://tiles.mapterhorn.com/tilejson.json'
		};
		sources['hillshadeSource'] = {
			type: 'raster-dem',
			url: 'https://tiles.mapterhorn.com/tilejson.json'
		};
	}

	const baseLayers: maplibregl.LayerSpecification[] = [];

	if (isSatellite.value) {
		sources['satellite'] = {
			type: 'raster',
			tiles: [
				'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
			],
			tileSize: 256,
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
		glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
		sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${spriteFlavor}`,
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

function openLayerSelector() {
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
		rootMap.fitBounds(bounds, { padding });
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

function updateSelectedPath(from: GeoPoint, to: GeoPoint) {
	selectedPathCoords.value = [
		[from.lng, from.lat],
		[to.lng, to.lat]
	];
	selectedPathVisible.value = true;

	if (rootMap && mapReady) {
		const source = rootMap.getSource(SELECTED_PATH_SOURCE) as maplibregl.GeoJSONSource;
		if (source) {
			source.setData({
				type: 'Feature',
				geometry: { type: 'LineString', coordinates: selectedPathCoords.value },
				properties: {}
			});
		}
		if (rootMap.getLayer(SELECTED_PATH_LAYER)) {
			rootMap.setLayoutProperty(SELECTED_PATH_LAYER, 'visibility', 'visible');
		}
	}
}

function hideSelectedPath() {
	selectedPathVisible.value = false;
	selectedPathCoords.value = [];
	if (rootMap && mapReady && rootMap.getLayer(SELECTED_PATH_LAYER)) {
		rootMap.setLayoutProperty(SELECTED_PATH_LAYER, 'visibility', 'none');
	}
}

function restoreSelectedPath() {
	if (!rootMap || !selectedPathVisible.value || selectedPathCoords.value.length < 2) return;

	const source = rootMap.getSource(SELECTED_PATH_SOURCE) as maplibregl.GeoJSONSource;
	if (source) {
		source.setData({
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: selectedPathCoords.value },
			properties: {}
		});
	}
	if (rootMap.getLayer(SELECTED_PATH_LAYER)) {
		rootMap.setLayoutProperty(SELECTED_PATH_LAYER, 'visibility', 'visible');
	}
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

const showPathToSelectedMarker = async () => {
	if (nearbyWaterSource.isActive.value && selectedMarker) {
		const currentLocation = await getCurrentLocation();
		const markerLngLat = selectedMarker.getLngLat();
		updateSelectedPath(currentLocation, { lat: markerLngLat.lat, lng: markerLngLat.lng });
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
				hideSelectedPath();
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
const waitingForLocation = ref(false);

async function showUserLocation() {
	try {
		if (!watchId.value) {
			waitingForLocation.value = true;

			// request permission only on native platforms
			if (Capacitor.isNativePlatform()) {
				// Check if we have permission
				const permission = await Geolocation.checkPermissions();

				if (permission.location !== 'granted') {
					const requestResult = await Geolocation.requestPermissions();
					if (requestResult.location !== 'granted') {
						console.warn('Location permission not granted');
						return;
					}
				}
			}

			// Get current position
			const position = await Geolocation.getCurrentPosition({
				enableHighAccuracy: true,
				timeout: 10000,
				maximumAge: 0
			});

			waitingForLocation.value = false;

			const point: GeoPoint = {
				lat: position.coords.latitude,
				lng: position.coords.longitude
			};
			currentUserLocation.value = point;

			// Update or create location marker
			updateLocationMarker(point);

			startWatchingLocation();
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

function updateLocationMarker(point: GeoPoint) {
	if (!rootMap) return;

	// Update or create location marker
	if (!userLocationMarker) {
		userLocationMarker = createUserLocationMarker();
	}
	userLocationMarker.setLngLat([point.lng, point.lat]);
	userLocationMarker.addTo(rootMap);

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
	// Marker source with clustering
	map.addSource(MARKER_SOURCE_ID, {
		type: 'geojson',
		data: { type: 'FeatureCollection', features: [] },
		cluster: true,
		clusterMaxZoom: DISABLE_CLUSTERING_ZOOM - 1,
		clusterRadius: 50
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
		data: {
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: [] },
			properties: {}
		}
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

	pumpCalculation.setMap(map);
}

function setupMapEventListeners(map: maplibregl.Map) {
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

			// Do not navigate away while supply pipe calculation is active
			if (route.path.includes('supplypipe')) {
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
		center: savedView?.center || [15.274102, 48.135314],
		zoom: savedView?.zoom || 13,
		maxZoom: 19,
		dragRotate: true,
		touchZoomRotate: true,
		pitchWithRotate: true,
		pitch: 0
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

		rootMap.on('zoomend', debouncedMapMove);
		rootMap.on('dragend', debouncedMapMove);
		rootMap.on('moveend', debouncedMapMove);

		rootMap.on('pitchend', updateResetViewVisibility);
		rootMap.on('rotateend', updateResetViewVisibility);
		rootMap.on('moveend', updateResetViewVisibility);

		watchExternalLocationQuery();
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
}

:deep(.maplibregl-ctrl-bottom-left),
:deep(.maplibregl-ctrl-bottom-right) {
	margin-bottom: var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px));
}

.compass-fab {
	margin-top: calc(var(--ion-safe-area-top, 0) + (40px + 16px));
}
</style>

<style>
.darkMap {
	#map {
		background: #424d5c;
	}
}
</style>
