import { computed, ref } from 'vue';
import { Marker } from 'leaflet';
import { useRoute } from 'vue-router';

export interface NearbyMarker {
	marker: Marker;
	distance: number;
}

const list = ref<NearbyMarker[]>([]);
export function useNearbyWaterSource() {
	const route = useRoute();
	const isActive = computed(() => route.path.includes('nearbysources'));
	return { isActive, list };
}
