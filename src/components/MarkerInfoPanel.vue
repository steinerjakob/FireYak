<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { computed, ref, watch } from 'vue';
import { IonContent, IonCard, IonModal, IonThumbnail } from '@ionic/vue';
import MarkerInfo from '@/components/MarkerInfo.vue';
import MarkerInfoHeader from '@/components/MarkerInfoHeader.vue';
import { useScreenOrientation } from '@/composable/screenOrientation';
import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { useMapMarkerStore } from '@/store/app';

const route = useRoute();
const modal = ref();
const screenOrientation = useScreenOrientation();
const nearbyWaterSource = useNearbyWaterSource();
const markerStore = useMapMarkerStore();
const router = useRouter();

const showMarkerInfo = computed(() => {
	return !!route.params.markerId && !nearbyWaterSource.isActive.value;
});

const markerImage = computed(() => markerStore.selectedMarkerImages[0] || null);

const isMobile = ref(window.innerWidth < 768);
const showImages = async () => {
	router.push(`/markerimages/${route.params.markerId}`);
};
watch(screenOrientation.orientation, () => {
	isMobile.value = window.innerWidth < 768;
});

watch(showMarkerInfo, () => {
	isMobile.value = window.innerWidth < 768;
});
</script>

<template>
	<template v-if="isMobile">
		<ion-modal
			ref="modal"
			:is-open="showMarkerInfo"
			:breakpoints="[0.25, 0.4, 0.5, 0.75]"
			:initial-breakpoint="0.25"
			:backdrop-dismiss="false"
			:backdrop-opacity="0"
			:showBackdrop="false"
			:expand-to-scroll="false"
			handle-behavior="cycle"
			class="marker-info"
		>
			<template v-if="markerImage">
				<ion-thumbnail class="thumbnail-image floating-thumbnail" @click="showImages">
					<img alt="Marker preview image" :src="markerImage.thumburl" />
				</ion-thumbnail>
			</template>
			<MarkerInfoHeader></MarkerInfoHeader>
			<ion-content>
				<MarkerInfo></MarkerInfo>
			</ion-content>
		</ion-modal>
	</template>
	<template v-else-if="showMarkerInfo">
		<template v-if="markerImage">
			<ion-thumbnail class="thumbnail-image floating-thumbnail desktop" @click="showImages">
				<img alt="Marker preview image" :src="markerImage.thumburl" />
			</ion-thumbnail>
		</template>
		<ion-card class="desktop-card">
			<MarkerInfoHeader></MarkerInfoHeader>
			<MarkerInfo></MarkerInfo>
		</ion-card>
	</template>
</template>

<style scoped>
.marker-info {
	--height: 100%;
	--width: 100%;
	--backdrop-opacity: 0;
}

.marker-info::part(content) {
	position: relative;
	overflow: visible;
}

.floating-thumbnail {
	position: absolute;
	top: 0;
	left: 8px;
	transform: translateY(calc(-100% - 8px));
	--size: 100px;
	--border-radius: 12px;
	z-index: 1000;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
	cursor: pointer;
	border: 3px solid white;
	background: white;
	overflow: hidden;
	transition: transform 0.2s ease;

	&.desktop {
		left: 424px;
		top: calc(100% - 8px);
	}
}

.floating-thumbnail:active {
	transform: translateY(calc(-100% - 8px)) scale(0.95);
}

.floating-thumbnail img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.desktop-card {
	position: fixed;
	left: 0;
	top: 0;
	bottom: 0;
	width: 400px;
	z-index: 1000;

	border-radius: 0;
	overflow-y: auto;
}

@media (max-width: 767px) {
	.marker-info::part(content) {
		border-radius: 8px 8px 0 0;
		box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.1);
	}
}
</style>
