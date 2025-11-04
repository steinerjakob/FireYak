<template>
	<div :class="{ darkMap: isDarkMode }" style="height: 100%; width: 100%">
		<div id="map" style="height: 100%; width: 100%"></div>
		<!-- About FAB Button -->
		<ion-fab vertical="top" horizontal="start" slot="fixed">
			<ion-fab-button
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
		<ion-fab vertical="bottom" horizontal="end" slot="fixed">
			<ion-fab-button color="light" @click="showUserLocation" title="Location">
				<ion-icon :icon="navigate"></ion-icon>
			</ion-fab-button>
		</ion-fab>
		<ion-fab vertical="top" horizontal="end" slot="fixed">
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
import 'leaflet.locatecontrol';
import 'leaflet.locatecontrol/dist/L.Control.Locate.min.css';
import { nextTick, onMounted, watch } from 'vue';
import { debounce } from '@/helper/helper';
import { getMarkersForView, getNearbyMarkers } from '@/mapHandler/markerHandler';
import { useRoute, useRouter } from 'vue-router';
import { useMapMarkerStore } from '@/store/app';
import { useDarkMode } from '@/composable/darkModeDetection';
import { IonFab, IonFabButton, IonIcon } from '@ionic/vue';
import { informationCircle, analyticsOutline, navigate } from 'ionicons/icons';
import { usePumpCalculation } from '@/composable/pumpCalculation';
import nearbyMarker from '@/assets/icons/nearbyMarker.svg';
import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';

const MAP_ELEMENT_ID = 'map';
const MOVE_DEBOUNCE_MS = 200;
const DISABLE_CLUSTERING_ZOOM = 14;

const router = useRouter();
const route = useRoute();
const markerStore = useMapMarkerStore();
const { isDarkMode } = useDarkMode();
const pumpCalculation = usePumpCalculation();
const nearbyWaterSource = useNearbyWaterSource();

let rootMap: L.Map | null = null;
const fireMapCluster = new MarkerClusterGroup({
	disableClusteringAtZoom: DISABLE_CLUSTERING_ZOOM
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

const selectedMarker = L.marker(L.latLng(0, 0), { icon: markerIcon });
const selectedMarkerPath = new L.Polyline([]);

function onMapMarkerClick(event: LeafletMouseEvent) {
	router.push(`/markers/${event.target.options.title}`);
}

function fitToSelectedMarkerPath() {
	if (rootMap) {
		// Calculate the effective visible bounds (top 2/3 of the map)
		const mapHeight = rootMap.getSize().y;
		const visibleHeightPixels = mapHeight - window.innerHeight / 2; // Top edge of the bottom 1/3

		const northWestLatLng = rootMap.getBounds().getNorthWest();
		// Convert the pixel point (full width, visibleHeightPixels) to LatLng
		const southEastVisiblePoint = L.point(rootMap.getSize().x, visibleHeightPixels);
		const southEastVisibleLatLng = rootMap.containerPointToLatLng(southEastVisiblePoint);

		const effectiveVisibleBounds = L.latLngBounds(northWestLatLng, southEastVisibleLatLng);

		// Only fit bounds if the path is not fully visible within the top 2/3 of the screen
		if (!effectiveVisibleBounds.contains(selectedMarkerPath.getBounds())) {
			rootMap.fitBounds(selectedMarkerPath.getBounds(), {
				paddingTopLeft: [0, 0], // Adjust padding to fit in upper 1/3
				paddingBottomRight: [0, window.innerHeight / 2]
			});
		}
	}
}

const debouncedMapMove = debounce(handleMapMovement, MOVE_DEBOUNCE_MS);

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

			if (nearbyWaterSource.isActive.value) {
				const currentLocation = getCurrentLocation()!;
				selectedMarkerPath.setLatLngs([currentLocation, latLng]);

				fitToSelectedMarkerPath();

				if (!rootMap?.hasLayer(selectedMarkerPath)) {
					rootMap?.addLayer(selectedMarkerPath);
				}
				// update polyline to show a direct connection!
			} else {
				rootMap?.removeLayer(selectedMarkerPath);
				if (isFirstWatch) {
					rootMap?.flyTo(latLng, DISABLE_CLUSTERING_ZOOM);
				} else {
					rootMap?.panTo(latLng);
				}
			}
		} catch (e) {
			console.error(e);
		} finally {
			isFirstWatch = false;
		}
	}
);
const locationControl = L.control.locate({
	position: 'bottomright',
	flyTo: true,
	keepCurrentZoomLevel: true,
	setView: false,
	clickBehavior: { inView: 'setView', outOfView: 'setView', inViewNotFollowing: 'inView' }
});

function showUserLocation() {
	try {
		locationControl.setView();
	} catch {
		// do nothing.
	}
}

function getCurrentLocation(): LatLng | null {
	if (!rootMap) {
		return null;
	}
	if (locationControl._event && locationControl._event.latlng) {
		return locationControl._event.latlng;
	} else {
		// Fallback to map center or request location
		return rootMap.getCenter();
	}
}

async function searchNearbyMarkers() {
	if (!nearbyWaterSource.isActive.value) {
		return;
	}
	const location = getCurrentLocation();
	if (!location) {
		return;
	}
	nearbyWaterSource.list.value = await getNearbyMarkers(location);
}
async function initMap() {
	await nextTick();
	rootMap = L.map(MAP_ELEMENT_ID, { zoomControl: false });

	rootMap.on('click', () => {
		// do not close if the supply pipe is open
		if (!route.path.includes('supplypipe')) {
			router.push('/');
		}
	});

	rootMap.on('contextmenu', (e) => {
		if (route.path.includes('supplypipe')) {
			pumpCalculation.markerSetAlert(e.latlng);
		}
	});

	rootMap.on('locationfound', () => {
		searchNearbyMarkers();
	});

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution:
			'© OpenStreetMap | <a href="https://github.com/steinerjakob/FireYak" target="_blank">Support on GitHub ⭐</a>'
	}).addTo(rootMap);

	locationControl.addTo(rootMap);
	locationControl.start();

	// @ts-ignore: is a js plugin without any typings
	if (!rootMap.restoreView()) {
		rootMap.setView([48.135314, 15.274102], 13);
	}

	// Important: force Leaflet to recalc size after layout is ready
	await ensureMapSize();

	handleMapMovement();

	// watch map movement
	rootMap.on('zoomend', debouncedMapMove);
	rootMap.on('dragend', debouncedMapMove);

	fireMapCluster.addTo(rootMap);
	pumpCalculation.setMap(rootMap);
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
</script>
<style scoped>
ion-fab {
	margin-top: var(--ion-safe-area-top, 0);
	margin-bottom: var(--ion-safe-area-bottom, 0);
	z-index: 1000;
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
