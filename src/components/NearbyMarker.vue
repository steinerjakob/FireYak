<script setup lang="ts">
import { IonItem, IonLabel, IonList } from '@ionic/vue';

import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { computed } from 'vue';

const { list } = useNearbyWaterSource();

const formattedList = computed(() => {
	console.log(list.value);
	return list.value.map((nearbyMarker) => ({
		key: nearbyMarker.marker.options.title || 'marker',
		marker: nearbyMarker.marker,
		distance: nearbyMarker.distance,
		distanceText:
			nearbyMarker.distance < 1000
				? `${Math.round(nearbyMarker.distance)}m`
				: `${(nearbyMarker.distance / 1000).toFixed(1)}km`
	}));
});
</script>

<template>
	<ion-list class="info-list">
		<!-- Nearby Water Sources -->
		<ion-item v-for="item in formattedList" :key="item.key" lines="none">
			<img
				slot="start"
				:src="item.marker.getIcon().options.iconUrl"
				style="height: 24px"
				alt="Target marker"
			/>
			<ion-label>
				<h3>Water Source</h3>
				<p>{{ item.distanceText }} away</p>
			</ion-label>
		</ion-item>
	</ion-list>
</template>

<style scoped>
.info-list {
	background: transparent;
	padding-top: 4px;
}

ion-item {
	--background: transparent;
	--padding-start: 12px;
	--padding-end: 12px;
	--inner-padding-end: 0;
	--min-height: 48px;
}

ion-icon {
	font-size: 20px;
	margin-right: 8px;
}

ion-label h3 {
	font-weight: 600;
	font-size: 0.875rem;
	color: var(--ion-color-medium);
	margin-bottom: 2px;
}

ion-label p {
	font-size: 1rem;
	color: var(--ion-color-dark);
	margin-top: 0;
}

.loading-note {
	padding: 12px;
	display: block;
}
</style>
