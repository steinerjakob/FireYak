import { computed, ref, shallowRef } from 'vue';
import type { HoseRoute } from '@/mapHandler/nearbyRouting';
import type { RouteSegment } from '@/helper/routeProfile';
import { routeStretches, stretchForRun, type RouteStretch } from '@/helper/routeDetails';

/**
 * State of the route details card (plan §6.8), shared by the map, the pump
 * calculation and the card: which line it shows (`selected`: the nearby /
 * marker route; `pump`: the pump line), the data of both lines and the
 * focused stretch. A module singleton like the other map composables.
 */

export type RouteDetailsSource = 'selected' | 'pump';

/** A tapped run of a line (its feature properties). */
export type TappedRun = Pick<RouteSegment, 'from' | 'to' | 'steep' | 'offRoad'>;

const selectedRoute = shallowRef<HoseRoute | null>(null);
const pumpSegments = shallowRef<RouteSegment[]>([]);
const source = ref<RouteDetailsSource | null>(null);
const focusId = ref<string | null>(null);

const stretches = computed<RouteStretch[]>(() => {
	if (source.value === 'selected') {
		const route = selectedRoute.value;
		return route?.routed ? routeStretches(route.segments) : [];
	}
	if (source.value === 'pump') return routeStretches(pumpSegments.value);
	return [];
});

const focusedStretch = computed(
	() => stretches.value.find((stretch) => stretch.id === focusId.value) ?? null
);

/** Opens the card for a line; a tapped coloured or dashed run focuses its stretch. */
function openDetails(which: RouteDetailsSource, run?: TappedRun | null) {
	source.value = which;
	focusId.value = run ? (stretchForRun(stretches.value, run)?.id ?? null) : null;
}

function closeDetails() {
	source.value = null;
	focusId.value = null;
}

/** Focuses a stretch of the open card (a row tap), or clears the focus. */
function focusStretch(id: string | null) {
	focusId.value = focusId.value === id ? null : id;
}

/** The selected route changed (or is gone): a gone route closes its card. */
function setSelectedRoute(route: HoseRoute | null) {
	selectedRoute.value = route;
	if (!route && source.value === 'selected') closeDetails();
	else if (focusId.value && !focusedStretch.value) focusId.value = null;
}

/** The pump line's runs changed (empty when it is cleared or straight). */
function setPumpSegments(segments: RouteSegment[]) {
	pumpSegments.value = segments;
	if (focusId.value && !focusedStretch.value) focusId.value = null;
}

export function useRouteDetails() {
	return {
		selectedRoute,
		pumpSegments,
		source,
		focusId,
		stretches,
		focusedStretch,
		isOpen: computed(() => source.value !== null),
		openDetails,
		closeDetails,
		focusStretch,
		setSelectedRoute,
		setPumpSegments
	};
}
