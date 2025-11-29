<template>
	<div :class="{ darkMap: isDarkMode }" style="height: 100%; width: 100%">
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
		<ion-fab vertical="bottom" horizontal="start" slot="fixed">
			<ion-fab-button
				color="light"
				@click="router.push('/supplypipe')"
				:title="$t('pumpCalculation.openInfo')"
			>
				<ion-icon :icon="analyticsOutline"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<ion-fab class="location-fab" vertical="bottom" horizontal="end" slot="fixed" size="small">
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
	</div>
</template>
<script lang="ts" setup>
import 'leaflet/dist/leaflet.css';
import L, { LatLng, LeafletMouseEvent } from 'leaflet';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
// @ts-ignore: does not find typings
import { MarkerClusterGroup } from 'leaflet.markercluster';
import selectedMarkerIcon from '../assets/markers/selectedmarker.png';
import '../plugins/leaflet.restoreview.js';
import { nextTick, onMounted, watch, ref, onUnmounted } from 'vue';
import { debounce } from '@/helper/helper';
import { getMarkersForView, getNearbyMarkers } from '@/mapHandler/markerHandler';
import { useRoute, useRouter } from 'vue-router';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { useDarkMode } from '@/composable/darkModeDetection';
import { IonFab, IonFabButton, IonIcon, IonSpinner } from '@ionic/vue';
import { informationCircle, analyticsOutline, navigate, navigateOutline } from 'ionicons/icons';
import { usePumpCalculation } from '@/composable/pumpCalculation';
import nearbyMarker from '@/assets/icons/nearbyMarker.svg';
import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import icon from 'leaflet/dist/images/marker-icon-2x.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';
import { useDefaultStore } from '@/store/defaultStore';
import { Geolocation } from '@capacitor/geolocation';

const MAP_ELEMENT_ID = 'map';
const MOVE_DEBOUNCE_MS = 200;
const DISABLE_CLUSTERING_ZOOM = 15;

const router = useRouter();
const route = useRoute();
const markerStore = useMapMarkerStore();
const { isDarkMode } = useDarkMode();
const pumpCalculation = usePumpCalculation();
const nearbyWaterSource = useNearbyWaterSource();
const defaultStore = useDefaultStore();

let rootMap: L.Map | null = null;
const fireMapCluster = new MarkerClusterGroup({
	disableClusteringAtZoom: DISABLE_CLUSTERING_ZOOM,
	spiderfyOnMaxZoom: false,
	showCoverageOnHover: false,
	zoomToBoundsOnClick: true,
	maxClusterRadius: 50
});

// Ensure Leaflet recalculates the map size once layout is settled
async function ensureMapSize() {
	await nextTick();
	await new Promise((r) => requestAnimationFrame(() => r(undefined)));
	rootMap?.invalidateSize();
}

async function handleMapMovement() {
	// do not fetch data for big zoom areas!
	if (!rootMap || rootMap.getZoom() <= 9) return;

	const markersToAdd = await getMarkersForView(rootMap.getBounds());
	fireMapCluster.clearLayers();
	markersToAdd.forEach((marker) => {
		marker.on('click', onMapMarkerClick);
		fireMapCluster.addLayer(marker);
	});
}

const markerIcon = L.icon({
	iconUrl: selectedMarkerIcon,
	iconSize: [56, 56]
});

//http://localhost:5173/#/?lat=48.1292912&lng=15.2728629&zoom=15&external=true

const DefaultIcon = L.icon({
	iconUrl: icon,
	shadowUrl: iconShadow,
	iconSize: [25, 41],
	iconAnchor: [12, 41]
});

const selectedMarker = L.marker(L.latLng(0, 0), { icon: markerIcon });
const selectedMarkerPath = new L.Polyline([]);

// Custom external location marker
let customLocationMarker: L.Marker | null = null;

function onMapMarkerClick(event: LeafletMouseEvent) {
	L.DomEvent.stopPropagation(event);
	router.push(`/markers/${event.target.options.title}`);
}

function fitMapToLayer() {
	const polyLine = pumpCalculation.isActive.value ? pumpCalculation.polyline : selectedMarkerPath;
	if (rootMap && polyLine && rootMap?.hasLayer(polyLine)) {
		const visibleMapView = defaultStore.visibleMapView;

		const defaultPadding = 16;
		rootMap.fitBounds(polyLine.getBounds(), {
			paddingTopLeft: [defaultPadding + visibleMapView.x, visibleMapView.top + defaultPadding],
			paddingBottomRight: [defaultPadding, visibleMapView.yMax - visibleMapView.y]
		});
	} else if (rootMap && rootMap.hasLayer(selectedMarker)) {
		// If no polyline is visible but selectedMarker is, center it
		const visibleMapView = defaultStore.visibleMapView;
		const defaultPadding = 16;

		// Calculate the center point of the visible area between paddingTopLeft and paddingBottomRight
		const paddingTopLeft: L.PointExpression = [
			defaultPadding + visibleMapView.x,
			visibleMapView.top + defaultPadding
		];
		const paddingBottomRight: L.PointExpression = [
			defaultPadding,
			visibleMapView.yMax - visibleMapView.y
		];

		// Calculate the center offset in pixels
		const centerOffsetX = (paddingTopLeft[0] - paddingBottomRight[0]) / 2;
		const centerOffsetY = (paddingTopLeft[1] - paddingBottomRight[1]) / 2;

		// Get the current center point and convert to container point
		const markerLatLng = selectedMarker.getLatLng();
		const markerPoint = rootMap.latLngToContainerPoint(markerLatLng);

		// Adjust the point to account for the padding offset
		const adjustedPoint = L.point(markerPoint.x - centerOffsetX, markerPoint.y - centerOffsetY);

		// Convert back to LatLng and pan to it
		const adjustedLatLng = rootMap.containerPointToLatLng(adjustedPoint);
		rootMap.panTo(adjustedLatLng);
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
	if (nearbyWaterSource.isActive.value && rootMap?.hasLayer(selectedMarker)) {
		const currentLocation = await getCurrentLocation()!;
		selectedMarkerPath.setLatLngs([currentLocation, selectedMarker.getLatLng()]);

		if (!rootMap?.hasLayer(selectedMarkerPath)) {
			rootMap?.addLayer(selectedMarkerPath);
		}
		fitMapToLayer();
		// update polyline to show a direct connection!
	}
};

let isFirstWatch = true;
// Watch store's selectedMarker and update map display
watch(
	() => markerStore.selectedMarker,
	(marker) => {
		if (!marker) {
			// Remove marker from map if no selection
			if (rootMap?.hasLayer(selectedMarker)) {
				rootMap?.removeLayer(selectedMarker);
				rootMap?.removeLayer(selectedMarkerPath);
			}
			return;
		}

		try {
			const latLng = L.latLng(
				marker.lat || marker.center?.lat || 0,
				marker.lon || marker.center?.lon || 0
			);
			selectedMarker.setLatLng(latLng);

			if (!rootMap?.hasLayer(selectedMarker)) {
				rootMap?.addLayer(selectedMarker);
			}

			showPathToSelectedMarker();
			if (!nearbyWaterSource.isActive.value) {
				rootMap?.removeLayer(selectedMarkerPath);
				if (isFirstWatch) {
					rootMap?.flyTo(latLng, DISABLE_CLUSTERING_ZOOM);
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
// Replace locationControl with custom location tracking
let userLocationMarker: L.CircleMarker | null = null;
const watchId = ref<string | null>(null);
const currentUserLocation = ref<LatLng | null>(null);
const waitingForLocation = ref(false);

async function showUserLocation() {
	try {
		if (!watchId.value) {
			waitingForLocation.value = true;

			// Check if we have permission
			const permission = await Geolocation.checkPermissions();

			if (permission.location !== 'granted') {
				const requestResult = await Geolocation.requestPermissions();
				if (requestResult.location !== 'granted') {
					console.warn('Location permission not granted');
					return;
				}
			}

			// Get current position
			const position = await Geolocation.getCurrentPosition({
				enableHighAccuracy: true,
				timeout: 10000,
				maximumAge: 0
			});

			waitingForLocation.value = false;

			const latLng = L.latLng(position.coords.latitude, position.coords.longitude);
			currentUserLocation.value = latLng;

			// Update or create location marker
			updateLocationMarker(latLng);

			startWatchingLocation();
		}

		// Fly to user location
		if (rootMap && userLocationMarker) {
			rootMap.flyTo(
				userLocationMarker?.getLatLng(),
				Math.max(rootMap.getZoom(), DISABLE_CLUSTERING_ZOOM)
			);
		}
	} catch (error) {
		console.error('Error getting location:', error);
		waitingForLocation.value = false;
	}
}

function updateLocationMarker(latLng: LatLng) {
	if (!rootMap) return;

	// Update or create location marker
	if (userLocationMarker) {
		userLocationMarker.setLatLng(latLng);
	} else {
		userLocationMarker = L.circleMarker(latLng, {
			radius: 8,
			weight: 3,
			color: '#fff',
			fillColor: '#136AEC',
			fillOpacity: 1
		}).addTo(rootMap);
	}
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
				const latLng = L.latLng(position.coords.latitude, position.coords.longitude);
				currentUserLocation.value = latLng;
				updateLocationMarker(latLng);
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

async function getCurrentLocation(): Promise<LatLng> {
	if (currentUserLocation.value) {
		return currentUserLocation.value;
	} else {
		await showUserLocation();
	}

	// if a custom location is active, use it to find the nearest water source
	if (customLocationMarker) {
		return customLocationMarker.getLatLng();
	}
	// Fallback to map center
	return rootMap!.getCenter();
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
async function initMap() {
	await nextTick();

	// Check if map already exists and remove it
	if (rootMap) {
		rootMap.remove();
		rootMap = null;
	}

	rootMap = L.map(MAP_ELEMENT_ID, { zoomControl: false });
	//L.control.scale().addTo(rootMap);

	setupMapEventListeners();
	addTileLayer();
	restoreMapView();

	// Important: force Leaflet to recalc size after layout is ready
	await ensureMapSize();

	handleMapMovement();

	// watch map movement
	rootMap.on('zoomend', debouncedMapMove);
	rootMap.on('dragend', debouncedMapMove);
	rootMap.on('moveend', debouncedMapMove);

	fireMapCluster.addTo(rootMap);
	pumpCalculation.setMap(rootMap);

	watchExternalLocationQuery();
}

function setupMapEventListeners() {
	if (!rootMap) return;

	rootMap.on('click', handleMapClick);
	rootMap.on('contextmenu', handleMapContextMenu);
}

function handleMapClick() {
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
}

function handleMapContextMenu(e: LeafletMouseEvent) {
	if (route.path.includes('supplypipe')) {
		pumpCalculation.markerSetAlert(e.latlng);
	}
}

function addTileLayer() {
	if (!rootMap) return;

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution:
			'© OpenStreetMap | <a href="https://github.com/steinerjakob/FireYak" target="_blank">Support on GitHub ⭐</a>'
	}).addTo(rootMap);
}

function restoreMapView() {
	if (!rootMap) return;

	// @ts-ignore: is a js plugin without any typings
	if (!rootMap.restoreView()) {
		rootMap.setView([48.135314, 15.274102], 13);
	}
}

function watchExternalLocationQuery() {
	watch(
		() => route.query,
		(query) => {
			if (query.external === 'true' && query.lat && query.lng && query.zoom && rootMap) {
				const lat = parseFloat(query.lat as string);
				const lng = parseFloat(query.lng as string);
				const zoom = parseFloat(query.zoom as string);
				const latLng = L.latLng(lat, lng);

				if (customLocationMarker) {
					customLocationMarker.setLatLng(latLng);
				} else {
					customLocationMarker = L.marker(latLng, { icon: DefaultIcon }).addTo(rootMap);
				}
				rootMap.setView(latLng, zoom);
			}
		},
		{ immediate: true }
	);
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
});

onUnmounted(() => {
	stopWatchingLocation();
});
</script>
<style scoped>
ion-fab {
	margin-top: var(--ion-safe-area-top, 0);
	margin-bottom: var(--ion-safe-area-bottom, 0);
	z-index: 1000;
}

.location-fab {
	margin-bottom: calc(var(--ion-safe-area-bottom, 0) + 56px + 16px);
}

:deep(.leaflet-bottom) {
	margin-bottom: env(safe-area-inset-bottom);
}

:deep(.leaflet-control-locate) {
	display: none;
}
</style>

<style>
.darkMap {
	#map {
		background: #000;
	}

	.leaflet-layer,
	.leaflet-control-zoom-in,
	.leaflet-control-zoom-out,
	.leaflet-control-attribution {
		filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
	}
}
</style>
