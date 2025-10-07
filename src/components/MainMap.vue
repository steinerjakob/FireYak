<template>
	<div id="map" style="width: 100%; height: 100%"></div>
</template>
<script lang="ts" setup>
import 'leaflet/dist/leaflet.css';
import L, { LeafletMouseEvent } from 'leaflet';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
// @ts-ignore: does not find typings
import { MarkerClusterGroup } from 'leaflet.markercluster';
import selectedMarkerIcon from '../assets/markers/selectedmarker.png';
// ... existing code ...
import '../plugins/leaflet.restoreview.js';
import 'leaflet.locatecontrol';
import 'leaflet.locatecontrol/dist/L.Control.Locate.min.css';
import { nextTick, onMounted, watch } from 'vue';
import { debounce } from '@/helper/helper';
import { getMarkersForView } from '@/mapHandler/markerHandler';
import { useRoute, useRouter } from 'vue-router';

const MAP_ELEMENT_ID = 'map';
const MOVE_DEBOUNCE_MS = 200;

const router = useRouter();
const route = useRoute();
let rootMap: L.Map | null = null;
const fireMapCluster = new MarkerClusterGroup();

// Ensure Leaflet recalculates the map size once layout is settled
async function ensureMapSize() {
	await nextTick();
	await new Promise((r) => requestAnimationFrame(() => r(undefined)));
	rootMap?.invalidateSize();
}

// ... existing code ...
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

function onMapMarkerClick(event: LeafletMouseEvent) {
	const latLng = event.target.getLatLng();
	rootMap?.panTo(latLng);
	selectedMarker.setLatLng(latLng);
	if (!rootMap?.hasLayer(selectedMarker)) {
		rootMap?.addLayer(selectedMarker);
	}
	router.push(`/markers/${event.target.options.title}`);
}

const debouncedMapMove = debounce(handleMapMovement, MOVE_DEBOUNCE_MS);

onMounted(async () => {
	await nextTick();
	rootMap = L.map(MAP_ELEMENT_ID);

	rootMap.on('click', () => {
		if (rootMap?.hasLayer(selectedMarker)) {
			rootMap?.removeLayer(selectedMarker);
			router.push('/');
		}
	});

	watch(
		() => route.path,
		(path) => {
			if (path === '/' && rootMap?.hasLayer(selectedMarker)) {
				rootMap?.removeLayer(selectedMarker);
			}
		}
	);

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '© OpenStreetMap'
	}).addTo(rootMap);

	const locationControl = L.control
		.locate({
			position: 'bottomright',
			flyTo: true,
			keepCurrentZoomLevel: true,
			setView: false,
			clickBehavior: { inView: 'setView', outOfView: 'setView', inViewNotFollowing: 'inView' }
		})
		.addTo(rootMap);
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
});
</script>
