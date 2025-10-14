<script setup lang="ts">
import {
	IonButton,
	IonIcon,
	IonHeader,
	IonToolbar,
	IonTitle,
	IonButtons,
	isPlatform
} from '@ionic/vue';
import { navigate, shareSocial } from 'ionicons/icons';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMapMarkerStore } from '@/store/app';

const markerStore = useMapMarkerStore();

const { t } = useI18n();
const markerData = computed(() => markerStore.selectedMarker);

const getTitle = () => {
	if (!markerData.value) return t('markerInfo.title.locationInfo');

	const emergency = markerData.value.tags?.emergency;
	const amenity = markerData.value.tags?.amenity;
	const name = markerData.value.tags?.name;

	if (name) return name;
	if (emergency === 'fire_hydrant') return t('markerInfo.title.fireHydrant');
	if (emergency === 'water_tank') return t('markerInfo.title.waterTank');
	if (emergency === 'suction_point') return t('markerInfo.title.suctionPoint');
	if (emergency === 'fire_water_pond') return t('markerInfo.title.fireWaterPond');
	if (amenity === 'fire_station') return t('markerInfo.title.fireStation');

	return t('markerInfo.title.locationInfo');
};

const openNavigation = () => {
	if (!markerData.value) return;

	const lat = markerData.value.lat || markerData.value.center?.lat;
	const lon = markerData.value.lon || markerData.value.center?.lon;

	if (lat && lon) {
		if (isPlatform('mobile')) {
			// Create a universal geo URL that works on both iOS and Android
			// iOS will open Apple Maps, Android will show options including Google Maps
			const geoUrl = `geo:${lat},${lon}?q=${lat},${lon}`;
			window.open(geoUrl, '_system');
		} else {
			const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
			window.open(googleMapsUrl, '_system');
		}
	}
};

const shareMarker = async () => {
	if (!markerData.value) return;

	const markerId = markerData.value.id;
	const url = `${window.location.origin}/#/markers/${markerId}`;
	const title = getTitle();

	try {
		if (navigator.share) {
			await navigator.share({
				title: title,
				text: t('markerInfo.share.text', { title }),
				url: url
			});
		} else {
			// Fallback: copy to clipboard
			await navigator.clipboard.writeText(url);
			alert(t('markerInfo.share.copiedToClipboard'));
		}
	} catch (error) {
		// User cancelled share or error occurred
		console.error('Error sharing:', error);
	}
};
</script>

<template>
	<ion-header class="ion-no-border">
		<ion-toolbar>
			<ion-title>{{ getTitle() }}</ion-title>
			<ion-buttons slot="end">
				<ion-button @click="shareMarker" :title="t('markerInfo.share.title')">
					<ion-icon :icon="shareSocial" />
				</ion-button>
				<ion-button @click="openNavigation" :title="t('markerInfo.navigation.title')">
					<ion-icon :icon="navigate" />
				</ion-button>
			</ion-buttons>
		</ion-toolbar>
	</ion-header>
</template>

<style scoped>
ion-header {
	border-bottom: 1px solid var(--ion-color-light-shade);
}
</style>
