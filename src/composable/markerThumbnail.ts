import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { useNetworkStatus } from '@/composable/networkStatus';
import { useMapMarkerStore } from '@/store/mapMarkerStore';

/** Size of the floating photo thumbnail of the marker info (`--size` in `MarkerInfoPanel.vue`). */
export const MARKER_THUMBNAIL_PX = 100;

/**
 * Whether the marker info is shown and which photo its floating thumbnail
 * previews: the marker info panel draws it, the route details card keeps
 * clear of it on desktop. Call in a component's setup.
 */
export function useMarkerThumbnail() {
	const route = useRoute();
	const nearbyWaterSource = useNearbyWaterSource();
	const markerStore = useMapMarkerStore();
	const { isOnline } = useNetworkStatus();

	const showMarkerInfo = computed(
		() => !!route.params.markerId && !nearbyWaterSource.isActive.value
	);

	// Photos need a connection — hide the thumbnail entry point while offline
	// rather than showing a stale/broken image.
	const markerImage = computed(
		() => (isOnline.value ? markerStore.selectedMarkerImages[0] : null) || null
	);

	return {
		showMarkerInfo,
		markerImage,
		thumbnailShown: computed(() => showMarkerInfo.value && markerImage.value !== null)
	};
}
