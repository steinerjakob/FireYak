import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoPoint } from '@/types/geo';
import type { HoseRoute, RouteFallback } from '@/mapHandler/nearbyRouting';
import { toRef } from '@/helper/osmRef';
import {
	LIST_QUIET_MS,
	compareEntries,
	listInUse,
	mergeSilentUpdate
} from '@/helper/nearbyListMerge';

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

/** How long a silently updated entry stays highlighted. */
export const UPDATE_HIGHLIGHT_MS = 1200;

const list = ref<NearbyMarker[]>([]);
/** Entries (refs) whose metres just changed in a silent recompute. */
const updatedRefs = ref<Set<string>>(new Set());
let lastInteractionAt = Number.NEGATIVE_INFINITY;
let resortTimer: ReturnType<typeof setTimeout> | null = null;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (marker: NearbyMarker) => toRef(marker.element.type, marker.element.id);

function clearResort(): void {
	if (resortTimer) clearTimeout(resortTimer);
	resortTimer = null;
}

/** Re-sorts once the list has been left alone (plan §10 question 5). */
function scheduleResort(): void {
	clearResort();
	const wait = Math.max(0, lastInteractionAt + LIST_QUIET_MS - Date.now());
	resortTimer = setTimeout(() => {
		resortTimer = null;
		if (listInUse(lastInteractionAt, Date.now())) return scheduleResort();
		list.value = [...list.value].sort(compareEntries);
	}, wait);
}

/** A regular search result (location update, list opened): replaces the list as before. */
function setList(next: NearbyMarker[]): void {
	clearResort();
	list.value = next;
}

/**
 * A silent recompute after late routing data (plan §6.9): metres update in
 * place with a short highlight; the order follows at once when the list is
 * not in use, else once it has been left alone for a moment.
 */
function applySilentUpdate(fresh: NearbyMarker[]): void {
	const resort = !listInUse(lastInteractionAt, Date.now());
	const merged = mergeSilentUpdate(list.value, fresh, keyOf, resort);
	list.value = merged.list;
	if (merged.resortPending) scheduleResort();
	else clearResort();
	if (merged.changed.length > 0) {
		updatedRefs.value = new Set(merged.changed);
		if (highlightTimer) clearTimeout(highlightTimer);
		highlightTimer = setTimeout(() => {
			updatedRefs.value = new Set();
			highlightTimer = null;
		}, UPDATE_HIGHLIGHT_MS);
	}
}

/** The user touched, scrolled or wheeled the list. */
function markInteraction(): void {
	lastInteractionAt = Date.now();
	if (resortTimer) scheduleResort();
}

export function useNearbyWaterSource() {
	const route = useRoute();
	const isActive = computed(() => route.path.includes('nearbysources'));

	return { isActive, list, updatedRefs, setList, applySilentUpdate, markInteraction };
}
