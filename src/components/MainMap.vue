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
onMounted(async () => {
	const map = L.map('map').fitWorld();

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '© OpenStreetMap'
	}).addTo(map);

	map.locate({ setView: true, maxZoom: 16 });

	function onLocationFound(e: any) {
		const radius = e.accuracy;

		L.marker(e.latlng, { icon: customMarker })
			.addTo(map)
			.bindPopup('You are within ' + radius + ' meters from this point')
			.openPopup();

		L.circle(e.latlng, radius).addTo(map);
	}

	map.on('locationfound', onLocationFound);
	function onLocationError(e: any) {
		alert(e.message);
	}

	map.on('locationerror', onLocationError);
});
</script>
