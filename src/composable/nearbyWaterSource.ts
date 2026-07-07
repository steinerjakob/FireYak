import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { OverPassElement } from '@/mapHandler/overPassApi';

export interface NearbyMarker {
	element: OverPassElement;
	/** Straight-line (haversine) distance in meters. */
	distance: number;
	/** Distance along the road network in meters, when routable. */
	routedDistance: number | null;
	/** Ranking key: routed distance, else weighted heuristic, else straight-line. */
	sortDistance: number;
	icon: string;
}

const list = ref<NearbyMarker[]>([]);
export function useNearbyWaterSource() {
	const route = useRoute();
	const isActive = computed(() => route.path.includes('nearbysources'));

	return { isActive, list };
}
