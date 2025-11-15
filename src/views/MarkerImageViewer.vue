<template>
	<ion-page>
		<ion-content :fullscreen="true">
			<div id="container"></div>
		</ion-content>
	</ion-page>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useIonRouter } from '@ionic/vue';
import { IonContent, IonPage } from '@ionic/vue';
import { useRoute } from 'vue-router';

// PhotoSwipe imports
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/photoswipe.css';
import { useMapMarkerStore } from '@/store/app';

const ionRouter = useIonRouter();
const route = useRoute();
const { selectedMarkerImages, fetchMarkerImageInfoById } = useMapMarkerStore();

const lightbox = ref<PhotoSwipeLightbox | null>(null);

// Function to handle gallery close event, navigating back
const handleClose = () => {
	if (ionRouter.canGoBack()) {
		ionRouter.back();
	} else {
		ionRouter.replace(`/markers/${route.params.relatedId}`);
	}
};

onMounted(async () => {
	let markerImages = selectedMarkerImages;
	if (!markerImages.length) {
		markerImages = await fetchMarkerImageInfoById(parseInt(route.params.relatedId as string));
	}

	// Map fetched image data to PhotoSwipe item format
	const pswpItems = markerImages.map((image) => {
		return {
			src: image.url,
			width: image.width, // Placeholder width
			height: image.height, // Placeholder height
			alt: 'Hydrant image' // Use title if available, otherwise a generic alt
		};
	});

	lightbox.value = new PhotoSwipeLightbox({
		gallery: '#container',
		dataSource: pswpItems,
		pswpModule: () => import('photoswipe'),
		clickToCloseNonZoomable: false
	});

	// Add a close event listener to navigate back
	lightbox.value.on('close', handleClose);

	lightbox.value.init();
	// Open the gallery immediately if there are items
	if (pswpItems.length > 0) {
		lightbox.value.loadAndOpen(0); // Open from the first image (index 0)
	}
});

onUnmounted(() => {
	// Destroy the PhotoSwipe instance to clean up resources
	if (lightbox.value) {
		lightbox.value.destroy();
		lightbox.value = null;
	}
});
</script>

<style>
.pswp__top-bar {
	margin-top: var(--ion-safe-area-top, 0);
}
</style>
