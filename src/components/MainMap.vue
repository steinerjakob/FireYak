<template lang="pug">
v-container.fill-height.ma-0.pa-0(fluid)
	#map.h-100.w-100
</template>

<script lang="ts" setup>
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
// @ts-ignore
import { MarkerClusterGroup } from 'leaflet.markercluster';

import '../plugins/leaflet.restoreview.js';

import 'leaflet.locatecontrol';
import 'leaflet.locatecontrol/dist/L.Control.Locate.min.css';

import { onMounted } from 'vue';

import { getMarkersForView } from '@/plugins/overPassApi';
import { debounce } from '@/helper/helper';

let rootMap: L.Map | null = null;

const fireMapCluster = new MarkerClusterGroup();
async function handleMapMovement() {
	// do not fetch data for big zoom areas!
	if (!rootMap || rootMap.getZoom() <= 9) {
		return;
	}
	const markersToAdd = await getMarkersForView(rootMap.getBounds());
	fireMapCluster.clearLayers();
	markersToAdd.forEach((marker) => {
		if (marker) {
			marker.on('click', (event) => {
				rootMap?.panTo(event.target.getLatLng());
			});
			fireMapCluster.addLayer(marker);
		}
	});
}

const debouncedMapMove = debounce(handleMapMovement, 200);

onMounted(async () => {
	rootMap = L.map('map');

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '© OpenStreetMap'
	}).addTo(rootMap);

	const locationControl = L.control
		.locate({
			position: 'bottomright',
			flyTo: true,
			keepCurrentZoomLevel: true,
			setView: 'once',
			clickBehavior: { inView: 'setView', outOfView: 'setView', inViewNotFollowing: 'inView' }
		})
		.addTo(rootMap);

	locationControl.start();

	// @ts-ignore
	if (!rootMap.restoreView()) {
		rootMap.setView([48.135314, 15.274102], 13);
	}
	handleMapMovement();

	//watch map movement
	rootMap.on('zoomend', debouncedMapMove);
	rootMap.on('dragend', debouncedMapMove);

	fireMapCluster.addTo(rootMap);
});
</script>
