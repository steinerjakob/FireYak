<template lang="pug">
v-container.fill-height.ma-0.pa-0(fluid)
	#map.h-100.w-100
</template>

<script lang="ts" setup>
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { MarkerClusterGroup } from 'leaflet.markercluster';

import { onMounted } from 'vue';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { getMarkersForView } from '@/plugins/overPassApi';

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

onMounted(async () => {
	rootMap = L.map('map');

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '© OpenStreetMap'
	}).addTo(rootMap);

	rootMap.locate({ setView: true, maxZoom: 16 });

	rootMap.on('locationfound', (e) => {
		const radius = e.accuracy;

		L.marker(e.latlng)
			.addTo(rootMap as L.Map)
			.bindPopup('You are within ' + radius + ' meters from this point')
			.openPopup();

		L.circle(e.latlng, radius).addTo(rootMap as L.Map);
	});

	rootMap.on('locationerror', (e) => {
		alert(e.message);
	});

	//watch map movement
	rootMap.on('zoomend', handleMapMovement);
	rootMap.on('dragend', handleMapMovement);

	fireMapCluster.addTo(rootMap);
});
</script>
