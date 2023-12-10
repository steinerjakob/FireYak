<template lang="pug">
v-container.fill-height.ma-0.pa-0(fluid)
	#map.h-100.w-100
</template>

<script lang="ts" setup>
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { onMounted } from 'vue';

import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIconShadow from 'leaflet/dist/images/marker-shadow.png';
const customMarker = L.icon({
	iconUrl: markerIcon,
	shadowUrl: markerIconShadow
});

let rootMap: L.Map | null = null;

onMounted(async () => {
	rootMap = L.map('map');

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '© OpenStreetMap'
	}).addTo(rootMap);

	rootMap.locate({ setView: true, maxZoom: 16 });

	rootMap.on('locationfound', (e) => {
		const radius = e.accuracy;

		L.marker(e.latlng, { icon: customMarker })
			.addTo(rootMap as L.Map)
			.bindPopup('You are within ' + radius + ' meters from this point')
			.openPopup();

		L.circle(e.latlng, radius).addTo(rootMap as L.Map);
	});

	rootMap.on('locationerror', (e) => {
		alert(e.message);
	});
});
</script>
