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
import { useI18n } from 'vue-i18n';

// PhotoSwipe imports
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import type PhotoSwipe from 'photoswipe';
import 'photoswipe/photoswipe.css';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import type { ImageSource } from '@/mapHandler/markerImageHandler';
import { useNetworkStatus } from '@/composable/networkStatus';
import { coerceRef } from '@/helper/osmRef';

const ionRouter = useIonRouter();
const route = useRoute();
const { t } = useI18n();
const { selectedMarkerImages, fetchMarkerImageInfoById } = useMapMarkerStore();
const { isOnline } = useNetworkStatus();

const lightbox = ref<PhotoSwipeLightbox | null>(null);

/** Badge colour per provider. Names are trademarks, so they stay untranslated. */
const sourceColor: Record<ImageSource, string> = {
	wikimedia: '#006699',
	panoramax: '#2a7a2a'
};

const sourceLabel: Record<ImageSource, string> = {
	wikimedia: 'Wikimedia Commons',
	panoramax: 'Panoramax'
};

/** Extra per-slide data carried through PhotoSwipe for the attribution badge. */
interface SlideAttribution {
	source?: ImageSource;
	descriptionUrl?: string;
}

/**
 * Aspect ratio used when an image's real size can't be determined — either the
 * provider doesn't report one and the preload failed, or it took too long.
 */
const FALLBACK_SIZE = { width: 1920, height: 1080 };

/**
 * Panoramax doesn't report pixel dimensions, and PhotoSwipe needs them upfront
 * to lay a slide out. Waiting on the full-size image is the only way to learn
 * them, so it is capped: a stalled CDN must not hold the gallery closed.
 */
const PRELOAD_TIMEOUT_MS = 4000;

// Function to handle gallery close event, navigating back
const handleClose = () => {
	if (ionRouter.canGoBack()) {
		ionRouter.back();
	} else {
		ionRouter.replace(`/markers/${route.params.relatedId}`);
	}
};

/** Resolves an image's natural dimensions, falling back after a timeout. */
const resolveImageSize = (src: string): Promise<{ width: number; height: number }> =>
	new Promise((resolve) => {
		const img = new Image();
		const timer = setTimeout(() => {
			img.onload = img.onerror = null;
			resolve(FALLBACK_SIZE);
		}, PRELOAD_TIMEOUT_MS);
		const settle = (size: { width: number; height: number }) => {
			clearTimeout(timer);
			resolve(size);
		};
		img.onload = () => settle({ width: img.naturalWidth, height: img.naturalHeight });
		img.onerror = () => settle(FALLBACK_SIZE);
		img.src = src;
	});

/**
 * Builds the attribution badge for the active slide. Everything is set through
 * DOM APIs rather than `innerHTML`: the description URL of a street-level photo
 * derives from a user-editable OSM tag, so it must never be parsed as markup.
 */
const renderBadge = (el: HTMLElement, slide: SlideAttribution | undefined) => {
	el.replaceChildren();

	if (!slide?.source) {
		el.style.display = 'none';
		return;
	}

	const badge = document.createElement('span');
	badge.className = 'pswp-source-badge';
	badge.style.background = sourceColor[slide.source];
	badge.textContent = sourceLabel[slide.source];
	el.append(badge);

	if (slide.descriptionUrl) {
		const link = document.createElement('a');
		link.className = 'pswp-source-link';
		link.href = slide.descriptionUrl;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		link.textContent = t('markerInfo.images.viewOnSource', { source: sourceLabel[slide.source] });
		el.append(link);
	}

	el.style.display = 'flex';
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
		const ref = coerceRef(route.params.relatedId as string);
		if (ref) {
			markerImages = await fetchMarkerImageInfoById(ref);
		}
	}

	// Map fetched image data to PhotoSwipe item format. Sources that report
	// their dimensions are used as-is; the rest are preloaded so PhotoSwipe
	// gets a real aspect ratio instead of stretching the slide.
	const pswpItems = await Promise.all(
		markerImages.map(async (image) => {
			const { width, height } =
				image.width > 0 && image.height > 0 ? image : await resolveImageSize(image.url);

			return {
				src: image.url,
				width,
				height,
				alt: t('markerInfo.images.alt'),
				source: image.source,
				descriptionUrl: image.descriptionurl
			};
		})
	);

	lightbox.value = new PhotoSwipeLightbox({
		gallery: '#container',
		dataSource: pswpItems,
		pswpModule: () => import('photoswipe'),
		clickToCloseNonZoomable: false
	});

	// Attribution badge, kept in sync with whichever slide is showing
	lightbox.value.on('uiRegister', () => {
		lightbox.value?.pswp?.ui?.registerElement({
			name: 'source-badge',
			order: 9,
			isButton: false,
			appendTo: 'wrapper',
			onInit: (el: HTMLElement, pswp: PhotoSwipe) => {
				el.style.display = 'none';
				const update = () => renderBadge(el, pswp.currSlide?.data as SlideAttribution | undefined);
				pswp.on('change', update);
				update();
			}
		});
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

/* Source badge — PhotoSwipe derives the class from registerElement's `name` */
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
	letter-spacing: 0.02em;
	opacity: 0.9;
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
