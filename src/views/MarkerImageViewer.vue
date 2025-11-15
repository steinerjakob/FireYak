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
import { fetchMediaWikiFiles, ImageInfo } from '@/mapHandler/markerImageHandler';
import { useRoute } from 'vue-router';

// PhotoSwipe imports
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/photoswipe.css';

const ionRouter = useIonRouter();
const route = useRoute();

const lightbox = ref<PhotoSwipeLightbox | null>(null);

// Function to handle gallery close event, navigating back
const handleClose = () => {
	if (ionRouter.canGoBack()) {
		ionRouter.back();
	}
};

onMounted(async () => {
	const imageData = await fetchMediaWikiFiles(parseInt(route.params.relatedId as string));
	const imageDataList: ImageInfo[] = [];
	imageData.forEach((image) => {
		imageDataList.push(...image.imageinfo);
	});

	// Map fetched image data to PhotoSwipe item format
	const pswpItems = imageDataList.map((image) => {
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

<style scoped>
#container {
	position: absolute;
	left: var(--ion-safe-area-left, 0);
	right: var(--ion-safe-area-right, 0);
	top: var(--ion-safe-area-top, 0);
	bottom: var(--ion-safe-area-bottom, 0);
}
</style>
