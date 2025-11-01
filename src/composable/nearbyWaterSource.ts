import { computed, ref, watch } from 'vue';
import L, { LayerGroup, Marker } from 'leaflet';
import { useRoute } from 'vue-router';
import { OverPassElement } from '@/mapHandler/overPassApi';

export interface NearbyMarker {
	element: OverPassElement;
	distance: number;
	icon: string;
}

const list = ref<NearbyMarker[]>([]);
export function useNearbyWaterSource() {
	const route = useRoute();
	const isActive = computed(() => route.path.includes('nearbysources'));

	return { isActive, list };
}
