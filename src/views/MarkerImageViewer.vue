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
import type PhotoSwipe from 'photoswipe';
import 'photoswipe/photoswipe.css';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import type { ImageSource } from '@/mapHandler/markerImageHandler';

const ionRouter = useIonRouter();
const route = useRoute();
const markerStore = useMapMarkerStore();
const { selectedMarkerImages } = markerStore;

const lightbox = ref<PhotoSwipeLightbox | null>(null);

// Source label and link configuration for each provider
const sourceConfig: Record<
	ImageSource,
	{ label: string; color: string; icon: string; linkLabel: string }
> = {
	wikimedia: {
		label: 'Wikimedia Commons',
		color: '#006699',
		icon: '📷',
		linkLabel: 'View on Commons'
	},
	panoramax: {
		label: 'Panoramax',
		color: '#2a7a2a',
		icon: '🌐',
		linkLabel: 'View on Panoramax'
	},
	mapillary: {
		label: 'Mapillary',
		color: '#d94f2b',
		icon: '📸',
		linkLabel: 'View on Mapillary'
	}
};

// Function to handle gallery close event — navigate back when the user closes the viewer
const handleClose = () => {
	if (ionRouter.canGoBack()) {
		ionRouter.back();
	} else {
		ionRouter.replace(`/markers/${route.params.relatedId}`);
	}
};

onMounted(async () => {
	const markerId = parseInt(route.params.relatedId as string);

	// Use cached images if available; otherwise fetch (including OSM tags for
	// Panoramax / Mapillary resolution)
	let markerImages = selectedMarkerImages;
	if (!markerImages.length) {
		let tags: Record<string, string> | undefined;
		if (!markerStore.selectedMarker || markerStore.selectedMarker.id !== markerId) {
			const marker = await markerStore.fetchMarkerById(markerId);
			tags = marker?.tags;
		} else {
			tags = markerStore.selectedMarker.tags;
		}
		markerImages = await markerStore.fetchMarkerImageInfoById(markerId, tags);
	}

	/**
	 * Resolves the natural pixel dimensions of an image URL.
	 * Used for sources (Panoramax) that don't provide dimensions in their API.
	 */
	const resolveImageSize = (src: string): Promise<{ width: number; height: number }> =>
		new Promise((resolve) => {
			const img = new Image();
			img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
			img.onerror = () => resolve({ width: 1920, height: 1080 }); // sensible fallback
			img.src = src;
		});

	// Map image data to PhotoSwipe slide items.
	// Images with known dimensions use them directly; images with unknown
	// dimensions (e.g. Panoramax) are preloaded so PhotoSwipe gets the correct
	// natural size and doesn't stretch them to fill the viewport.
	const pswpItems = await Promise.all(
		markerImages.map(async (image) => {
			// Resolve dimensions: use provided values if both are positive,
			// otherwise preload the image to read naturalWidth/naturalHeight.
			let { width, height } = image;
			if (!width || !height) {
				({ width, height } = await resolveImageSize(image.url));
			}

			return {
				src: image.url,
				width,
				height,
				alt: 'Water source image',
				_source: image.source as ImageSource,
				_descriptionurl: image.descriptionurl
			};
		})
	);

	lightbox.value = new PhotoSwipeLightbox({
		gallery: '#container',
		dataSource: pswpItems,
		pswpModule: () => import('photoswipe'),
		clickToCloseNonZoomable: false
	});

	// Register a source badge element that updates on each slide change
	lightbox.value.on('uiRegister', function () {
		lightbox.value!.pswp!.ui!.registerElement({
			name: 'source-badge',
			order: 9,
			isButton: false,
			appendTo: 'wrapper',
			html: '',
			onInit: (el: HTMLElement, pswp: PhotoSwipe) => {
				// Update badge content whenever the active slide changes
				pswp.on('change', () => {
					const slide = pswp.currSlide?.data as
						| { _source?: ImageSource; _descriptionurl?: string }
						| undefined;

					if (!slide?._source) {
						el.style.display = 'none';
						return;
					}

					const cfg = sourceConfig[slide._source];
					const linkHtml = slide._descriptionurl
						? `<a href="${slide._descriptionurl}" target="_blank" rel="noopener noreferrer" class="pswp-source-link">${cfg.linkLabel} ↗</a>`
						: '';

					el.innerHTML = `<span class="pswp-source-badge" style="background:${cfg.color};">${cfg.icon}&nbsp;${cfg.label}</span>${linkHtml}`;
					el.style.display = 'flex';
				});
			}
		});
	});

	lightbox.value.on('close', handleClose);
	lightbox.value.init();

	if (pswpItems.length > 0) {
		lightbox.value.loadAndOpen(0);
	}
});

onUnmounted(() => {
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

/* ── Source badge ──────────────────────────────────────────────────────── */

/* Registered via PhotoSwipe's registerElement — class is pswp__<name> */
.pswp__source-badge {
	position: absolute;
	bottom: calc(var(--ion-safe-area-bottom, 0px) + 60px);
	left: 12px;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 4px;
	pointer-events: auto;
	z-index: 200;
}

.pswp-source-badge {
	display: inline-block;
	padding: 4px 10px;
	border-radius: 12px;
	color: #fff;
	font-size: 0.75rem;
	font-weight: 600;
	opacity: 0.9;
	letter-spacing: 0.02em;
}

.pswp-source-link {
	display: inline-block;
	padding: 3px 8px;
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.55);
	color: #fff;
	font-size: 0.7rem;
	text-decoration: none;
	opacity: 0.85;
}

.pswp-source-link:hover {
	opacity: 1;
	text-decoration: underline;
}
</style>
