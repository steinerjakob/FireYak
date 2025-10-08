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
import '../plugins/leaflet.restoreview.js';
import 'leaflet.locatecontrol';
import 'leaflet.locatecontrol/dist/L.Control.Locate.min.css';
import { nextTick, onMounted, watch } from 'vue';
import { debounce } from '@/helper/helper';
import { getMarkerById, getMarkersForView } from '@/mapHandler/markerHandler';
import { useRoute, useRouter } from 'vue-router';

const MAP_ELEMENT_ID = 'map';
const MOVE_DEBOUNCE_MS = 200;
const DISABLE_CLUSTERING_ZOOM = 17;

const router = useRouter();
const route = useRoute();
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

async function showSelectMarkerForNode(markerId: string | undefined, shouldZoom = false) {
	if (!markerId) {
		rootMap?.removeLayer(selectedMarker);
		return;
	}
	try {
		const nodeInfo = await getMarkerById(Number(markerId));
		const latLng = L.latLng(
			nodeInfo?.lat || nodeInfo?.center?.lat || 0,
			nodeInfo?.lon || nodeInfo?.center?.lon || 0
		);
		selectedMarker.setLatLng(latLng);
		if (!rootMap?.hasLayer(selectedMarker)) {
			rootMap?.addLayer(selectedMarker);
		}
		if (shouldZoom) {
			rootMap?.flyTo(latLng, DISABLE_CLUSTERING_ZOOM);
		} else {
			rootMap?.panTo(latLng);
		}
	} catch (e) {
		console.error(e);
	}
}

function onMapMarkerClick(event: LeafletMouseEvent) {
	router.push(`/markers/${event.target.options.title}`);
}

const debouncedMapMove = debounce(handleMapMovement, MOVE_DEBOUNCE_MS);

onMounted(async () => {
	await nextTick();
	rootMap = L.map(MAP_ELEMENT_ID);

	rootMap.on('click', () => {
		router.push('/');
	});
	let isFirstWatch = true;
	watch(
		() => route.path,
		(path) => {
			if (path === '/' && rootMap?.hasLayer(selectedMarker)) {
				rootMap?.removeLayer(selectedMarker);
			}
			const markerId = (route.params.markerId as string) || undefined;

			showSelectMarkerForNode(markerId, isFirstWatch);
			isFirstWatch = false;
		},
		{ immediate: true }
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
