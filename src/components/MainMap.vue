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
	</div>
</template>
<script lang="ts" setup>
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import selectedMarkerIconUrl from '../assets/markers/selectedmarker.png';
import { nextTick, onMounted, watch, ref, onUnmounted } from 'vue';
import { debounce } from '@/helper/helper';
import { getMarkersForView, getNearbyMarkers, markerIconUrls } from '@/mapHandler/markerHandler';
import { useRoute, useRouter } from 'vue-router';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { useDarkMode } from '@/composable/darkModeDetection';
import { alertController, IonFab, IonFabButton, IonIcon, IonSpinner } from '@ionic/vue';
import {
	informationCircle,
	analyticsOutline,
	navigate,
	navigateOutline,
	add,
	remove,
	settings,
	addOutline,
	layers
} from 'ionicons/icons';
import { usePumpCalculation } from '@/composable/pumpCalculation';
import nearbyMarker from '@/assets/icons/nearbyMarker.svg';
import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { useDefaultStore } from '@/store/defaultStore';
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';
import { MapLayerSetting, useSettingsStore } from '@/store/settingsStore';
import { useMarkerEditStore } from '@/store/markerEditStore';
import { storeToRefs } from 'pinia';
import { useSettings } from '@/composable/settings';
import { useI18n } from 'vue-i18n';
import { GeoPoint, GeoBounds } from '@/types/geo';

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
const { showZoomButtons, mapLayer } = storeToRefs(settingsStore);
const { saveMapLayer } = useSettings();
const { t } = useI18n();

const isSatellite = ref(false);

let rootMap: maplibregl.Map | null = null;
let mapReady = false;

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

function getMapStyle(): maplibregl.StyleSpecification {
	const githubAttribution =
		' | <a href="https://github.com/steinerjakob/FireYak" target="_blank">Support on GitHub ⭐</a>';
	return {
		version: 8,
		glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
		sources: {
			osm: {
				type: 'raster',
				tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
				tileSize: 256,
				maxzoom: 19,
				attribution: `© OpenStreetMap${githubAttribution}`
			},
			satellite: {
				type: 'raster',
				tiles: [
					'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
				],
				tileSize: 256,
				maxzoom: 19,
				attribution: '&copy; Esri'
			},
			'carto-labels': {
				type: 'raster',
				tiles: [
					'https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png',
					'https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png',
					'https://c.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png',
					'https://d.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png'
				],
				tileSize: 256,
				maxzoom: 19,
				attribution: `&copy; CARTO${githubAttribution}`
			}
		},
		layers: [
			{ id: 'osm-layer', type: 'raster', source: 'osm' },
			{
				id: 'satellite-layer',
				type: 'raster',
				source: 'satellite',
				layout: { visibility: 'none' }
			},
			{
				id: 'carto-labels-layer',
				type: 'raster',
				source: 'carto-labels',
				layout: { visibility: 'none' }
			}
		]
	};
}

function applyMapLayerSelection(selection: MapLayerSetting) {
	if (!rootMap || !mapReady) return;

	if (selection === 'satellite') {
		rootMap.setLayoutProperty('osm-layer', 'visibility', 'none');
		rootMap.setLayoutProperty('satellite-layer', 'visibility', 'visible');
		rootMap.setLayoutProperty('carto-labels-layer', 'visibility', 'visible');
		isSatellite.value = true;
	} else {
		rootMap.setLayoutProperty('osm-layer', 'visibility', 'visible');
		rootMap.setLayoutProperty('satellite-layer', 'visibility', 'none');
		rootMap.setLayoutProperty('carto-labels-layer', 'visibility', 'none');
		isSatellite.value = false;
	}
}

async function openLayerSelector() {
	const alert = await alertController.create({
		header: t('map.layers.title'),
		inputs: [
			{
				type: 'radio',
				label: t('map.layers.standard'),
				value: 'standard',
				checked: mapLayer.value === 'standard'
			},
			{
				type: 'radio',
				label: t('map.layers.satellite'),
				value: 'satellite',
				checked: mapLayer.value === 'satellite'
			}
		],
		buttons: [
			{
				text: t('map.layers.cancel'),
				role: 'cancel'
			},
			{
				text: 'OK',
				handler: async (value: MapLayerSetting) => {
					await saveMapLayer(value);
					applyMapLayerSelection(value);
				}
			}
		]
	});

	await alert.present();
}

// Save/restore map view via localStorage (replaces leaflet.restoreview plugin)
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
	if (!bounds) return;

	const geojson = await getMarkersForView(bounds);
	const source = rootMap.getSource(MARKER_SOURCE_ID) as maplibregl.GeoJSONSource;
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
	} else if (selectedMarker) {
		// If no polyline is visible but selectedMarker is, center it
		const centerOffsetX = (padding.left - padding.right) / 2;
		const centerOffsetY = (padding.top - padding.bottom) / 2;

		const markerLngLat = selectedMarker.getLngLat();
		const markerPoint = rootMap.project(markerLngLat);

		const adjustedPoint = new maplibregl.Point(
			markerPoint.x - centerOffsetX,
			markerPoint.y - centerOffsetY
		);

		const adjustedLngLat = rootMap.unproject(adjustedPoint);
		rootMap.panTo(adjustedLngLat);
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
		const response = await map.loadImage(url);
		map.addImage(name, response.data);
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
			'circle-color': [
				'step',
				['get', 'point_count'],
				'#51bbd6',
				100,
				'#f1f075',
				750,
				'#f28cb1'
			],
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
				const coords = (feature.geometry as GeoJSON.Point).coordinates as [
					number,
					number
				];
				try {
					const expansionZoom = await source.getClusterExpansionZoom(
						feature.properties.cluster_id
					);
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

	const savedView = restoreMapView();

	rootMap = new maplibregl.Map({
		container: MAP_ELEMENT_ID,
		style: getMapStyle(),
		center: savedView?.center || [15.274102, 48.135314],
		zoom: savedView?.zoom || 13,
		attributionControl: {},
		maxZoom: 19
	});

	rootMap.on('load', async () => {
		if (!rootMap) return;
		mapReady = true;

		await loadMarkerImages(rootMap);
		addMapLayers(rootMap);
		setupMapEventListeners(rootMap);

		applyMapLayerSelection(mapLayer.value);

		// Important: force MapLibre to recalc size after layout is ready
		await ensureMapSize();

		handleMapMovement();

		// watch map movement
		rootMap.on('zoomend', debouncedMapMove);
		rootMap.on('dragend', debouncedMapMove);
		rootMap.on('moveend', debouncedMapMove);

		pumpCalculation.setMap(rootMap);

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
					customLocationMarker = new maplibregl.Marker()
						.setLngLat([lng, lat])
						.addTo(rootMap);
				}
				rootMap.setCenter([lng, lat]);
				rootMap.setZoom(zoom);
			}
		},
		{ immediate: true }
	);
}

function zoomIn() {
	rootMap?.zoomIn();
}

function zoomOut() {
	rootMap?.zoomOut();
}

onMounted(async () => {
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
		(val) => {
			applyMapLayerSelection(val);
		}
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

.fab-vertical-top {
	margin-top: var(--ion-safe-area-top, env(safe-area-inset-top, 0px));
}

.fab-vertical-bottom {
	margin-bottom: calc(var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 10px);
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
	margin-bottom: calc(var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 56px + 26px);
}

.add-hydrant-fab {
	margin-bottom: calc(var(--ion-safe-area-bottom, 0) + (56px + 21px) * 2);
}

.layers-fab {
	margin-top: calc(var(--ion-safe-area-top, 0) + (40px + 16px));
}

:deep(.maplibregl-ctrl-bottom-left),
:deep(.maplibregl-ctrl-bottom-right) {
	margin-bottom: var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px));
}
</style>

<style>
.darkMap {
	#map {
		background: #000;
	}

	.maplibregl-canvas {
		filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
	}
}
</style>
