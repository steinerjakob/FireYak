<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { ref } from 'vue';
import { IonContent, IonCard, IonModal, IonThumbnail } from '@ionic/vue';
import MarkerInfo from '@/components/MarkerInfo.vue';
import MarkerInfoHeader from '@/components/MarkerInfoHeader.vue';
import RouteSheetSection from '@/components/RouteSheetSection.vue';
import { provideRouteSheet, useIonModalBreakpoint } from '@/composable/modalBreakpointWatcher';
import { useScreenDetection } from '@/composable/screenDetection';
import { useMarkerThumbnail } from '@/composable/markerThumbnail';

const route = useRoute();
const modal = ref<typeof IonModal>();
const router = useRouter();
const { showMarkerInfo, markerImage } = useMarkerThumbnail();

const { isMobile } = useScreenDetection();
const showImages = async () => {
	router.push(`/markerimages/${route.params.markerId}`);
};

const initialBreakpoint = 0.25;
const breakpoints = [0.25, 0.5];

useIonModalBreakpoint(modal, initialBreakpoint);
provideRouteSheet(modal, breakpoints);
</script>

<template>
	<template v-if="isMobile">
		<ion-modal
			ref="modal"
			:is-open="showMarkerInfo"
			:breakpoints="breakpoints"
			:initial-breakpoint="initialBreakpoint"
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
				<!-- The route to this marker (phone): header row, expands in the sheet. -->
				<RouteSheetSection host="selected" />
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
			<MarkerInfoHeader class="sticky-header"></MarkerInfoHeader>
			<div class="scrollable-content">
				<MarkerInfo></MarkerInfo>
			</div>
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
		bottom: var(--ion-safe-area-bottom, 0);
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
	z-index: 1002;
	border-radius: 0;
	overflow: hidden;
	display: flex;
	flex-direction: column;
}

.desktop-card .sticky-header {
	flex-shrink: 0;
}

.desktop-card .scrollable-content {
	flex: 1;
	overflow-y: auto;
}

/* MD3 bottom sheet spec: 28px top corners on a solid surface. ios mode is
   intentionally left alone here so @rdlabo/ionic-theme-ios26's own
   modal-sheet rule (30px radius + glass background on this same
   ::part(content) element) applies instead of being overridden. */
:root[mode='md'] .marker-info::part(content) {
	border-radius: 28px 28px 0 0;
	box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.1);
}
</style>
