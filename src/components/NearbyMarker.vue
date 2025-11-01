<script setup lang="ts">
import { IonItem, IonLabel, IonList } from '@ionic/vue';

import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { useI18n } from 'vue-i18n';

const { list } = useNearbyWaterSource();
const router = useRouter();
const { t } = useI18n();

const getTitle = (markerData: OverPassElement) => {
	if (!markerData) return t('markerInfo.title.locationInfo');

	const emergency = markerData.tags?.emergency;
	const amenity = markerData.tags?.amenity;
	const name = markerData.tags?.name;

	if (name) return name;
	if (emergency === 'fire_hydrant') return t('markerInfo.title.fireHydrant');
	if (emergency === 'water_tank') return t('markerInfo.title.waterTank');
	if (emergency === 'suction_point') return t('markerInfo.title.suctionPoint');
	if (emergency === 'fire_water_pond') return t('markerInfo.title.fireWaterPond');
	if (amenity === 'fire_station') return t('markerInfo.title.fireStation');

	return t('markerInfo.title.locationInfo');
};

const formattedList = computed(() => {
	console.log(list.value);
	return list.value.map((nearbyMarker) => ({
		id: nearbyMarker.element.id,
		title: getTitle(nearbyMarker.element),
		icon: nearbyMarker.icon,
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
		<ion-item
			v-for="item in formattedList"
			:key="item.id"
			button
			@click="router.push(`/nearbysources/${item.id}`)"
		>
			<img slot="start" :src="item.icon" style="height: 24px" alt="Target marker" />
			<ion-label>
				<h3>{{ item.title }}</h3>
				<p>{{ item.distanceText }} {{ t('nearbyMarker.away') }}</p>
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
