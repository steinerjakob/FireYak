import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoPoint } from '@/types/geo';
import type { HoseRoute, RouteFallback } from '@/mapHandler/nearbyRouting';

export interface NearbyMarker {
	element: OverPassElement;
	/**
	 * Point the distances are measured to: the marker position, or for a pond
	 * area the shore point routing chose / its mapped suction point.
	 */
	target: GeoPoint;
	/** Straight-line (haversine) distance in meters. */
	distance: number;
	/** Length of the routed line in meters (same as the map label), when routable. */
	routedDistance: number | null;
	/** The routed line with its steep runs and warnings, when routed. */
	route: HoseRoute | null;
	/** Why the marker was not routed as asked (shown as a chip). */
	fallback: RouteFallback | null;
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
