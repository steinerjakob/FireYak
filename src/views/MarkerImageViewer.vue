<template>
	<ion-page>
		<ion-content :fullscreen="true">
			<!-- Photos need a connection — show a hint instead of a blank gallery -->
			<div v-if="!isOnline" class="offline-photos">
				<ion-icon :icon="cloudOfflineOutline" class="offline-photos-icon"></ion-icon>
				<p>{{ $t('markerInfo.messages.photosOfflineHint') }}</p>
				<ion-button fill="outline" @click="handleClose">
					{{ $t('pumpCalculation.buttons.close') }}
				</ion-button>
			</div>
			<div v-else id="container"></div>
		</ion-content>
	</ion-page>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useIonRouter } from '@ionic/vue';
import { IonButton, IonContent, IonIcon, IonPage } from '@ionic/vue';
import { cloudOfflineOutline } from 'ionicons/icons';
import { useRoute } from 'vue-router';

// PhotoSwipe imports
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/photoswipe.css';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { useNetworkStatus } from '@/composable/networkStatus';

const ionRouter = useIonRouter();
const route = useRoute();
const { selectedMarkerImages, fetchMarkerImageInfoById } = useMapMarkerStore();
const { isOnline } = useNetworkStatus();

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
	// Skip the fetch and the PhotoSwipe init entirely while offline — the
	// template shows the offline hint instead of the (otherwise empty)
	// gallery container.
	if (!isOnline.value) {
		return;
	}

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

.offline-photos {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 12px;
	height: 100%;
	padding: 32px;
	text-align: center;
}

.offline-photos-icon {
	font-size: 40px;
	color: var(--md-sys-on-surface-variant);
}
</style>
