import { computed, ref, shallowRef, type ComputedRef, type InjectionKey } from 'vue';
import { useI18n } from 'vue-i18n';
import type { HoseRoute } from '@/mapHandler/nearbyRouting';
import type { RouteSegment } from '@/helper/routeProfile';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import {
	INITIAL_SECTION_STATE,
	pumpLineDetailsView,
	routeDetailsView,
	routeStretches,
	sectionStateAfter,
	stretchForRun,
	type RouteDetailsView,
	type RouteSectionHost,
	type RouteSectionState,
	type RouteStretch
} from '@/helper/routeDetails';

/**
 * State of the route details (plan §6.8), shared by the map, the pump
 * calculation, the floating card (desktop marker info), the sheet sections
 * (phone) and the expanded row of the nearby list: which line was opened
 * last (`selected`: the nearby / marker route; `pump`: the pump line), the
 * data of both lines (which marker the selected route goes to, and which one
 * is being routed), the focused stretch and whether each sheet section is
 * expanded (for the session, not persisted). A module singleton like the
 * other map composables.
 */

export type RouteDetailsSource = RouteSectionHost;

/** A tapped run of a line (its feature properties). */
export type TappedRun = Pick<RouteSegment, 'from' | 'to' | 'steep' | 'offRoad'>;

const selectedRoute = shallowRef<HoseRoute | null>(null);
/** The marker the drawn selected route goes to (OSM ref), and the one a running request is for. */
const selectedRouteRef = ref<string | null>(null);
const pendingRouteRef = ref<string | null>(null);
const pumpSegments = shallowRef<RouteSegment[]>([]);
/** Off-road metres of the routed pump legs (the panel's number). */
const pumpOffRoadMeters = ref(0);
const source = ref<RouteDetailsSource | null>(null);
const focusId = ref<string | null>(null);
const sectionState = ref<RouteSectionState>(INITIAL_SECTION_STATE);
/**
 * Counts taps on a line: its sheet section (or the nearby list's selected
 * row) expands, grows the sheet and shows the focused row on each.
 */
const focusRequest = ref(0);

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

/**
 * Opens the details for a line; a tapped coloured or dashed run focuses its
 * stretch. `reveal` (a tap on the line or its badge) also expands the line's
 * sheet section (phone) and asks it to show the focused row.
 */
function openDetails(
	which: RouteDetailsSource,
	run?: TappedRun | null,
	options: { reveal?: boolean } = {}
) {
	source.value = which;
	focusId.value = run ? (stretchForRun(stretches.value, run)?.id ?? null) : null;
	if (options.reveal) {
		sectionState.value = sectionStateAfter(sectionState.value, which, 'focus');
		focusRequest.value++;
	}
}

function closeDetails() {
	source.value = null;
	focusId.value = null;
}

/** Focuses a stretch of the open card (a row tap), or clears the focus. */
function focusStretch(id: string | null) {
	focusId.value = focusId.value === id ? null : id;
}

/** A row tap in a sheet section: that line's stretch is focused (or unfocused). */
function selectStretch(which: RouteDetailsSource, id: string) {
	if (source.value !== which) {
		source.value = which;
		focusId.value = null;
	}
	focusStretch(id);
}

/** A tap on a sheet section's header. */
function toggleSection(which: RouteSectionHost) {
	sectionState.value = sectionStateAfter(sectionState.value, which, 'toggle');
}

/** A request for the selected route (to the marker `forRef`) started; its row shows it. */
function beginSelectedRoute(forRef: string | null) {
	pendingRouteRef.value = forRef;
}

/**
 * The selected route changed (or is gone) for the marker `forRef`: ends a
 * running request; a gone route closes its card.
 */
function setSelectedRoute(route: HoseRoute | null, forRef: string | null = null) {
	selectedRoute.value = route;
	selectedRouteRef.value = forRef;
	pendingRouteRef.value = null;
	if (!route && source.value === 'selected') closeDetails();
	else if (focusId.value && !focusedStretch.value) focusId.value = null;
}

/** The pump line's runs changed (empty when it is cleared or straight). */
function setPumpSegments(segments: RouteSegment[], offRoadMeters = 0) {
	pumpSegments.value = segments;
	pumpOffRoadMeters.value = offRoadMeters;
	if (focusId.value && !focusedStretch.value) focusId.value = null;
}

export function useRouteDetails() {
	return {
		selectedRoute,
		selectedRouteRef,
		pendingRouteRef,
		pumpSegments,
		pumpOffRoadMeters,
		source,
		focusId,
		stretches,
		focusedStretch,
		isOpen: computed(() => source.value !== null),
		openDetails,
		closeDetails,
		focusStretch,
		selectStretch,
		sectionState,
		focusRequest,
		toggleSection,
		beginSelectedRoute,
		setSelectedRoute,
		setPumpSegments
	};
}

/**
 * The details view model of a line (the card's and the sheet section's), in
 * the current locale and with the pump settings' hose length and name. Call
 * in a component's setup.
 */
export function useRouteDetailsView(
	which: () => RouteDetailsSource | null
): ComputedRef<RouteDetailsView | null> {
	const { t, locale } = useI18n();
	const pumpStore = usePumpCalculationStore();
	return computed(() => {
		const options = { t, locale: locale.value };
		const line = which();
		if (line === 'selected') {
			const route = selectedRoute.value;
			if (!route) return null;
			return routeDetailsView(route, {
				...options,
				tubeLength: pumpStore.tubeLength,
				hoseName: pumpStore.hoseName
			});
		}
		if (line === 'pump') {
			return pumpLineDetailsView(pumpSegments.value, options, pumpOffRoadMeters.value);
		}
		return null;
	});
}

/** What a bottom sheet offers its route section: growing to a higher breakpoint. */
export interface RouteSheet {
	grow(): Promise<void>;
}

/** Provided by the sheet panels (phone layout), injected by `RouteSheetSection.vue`. */
export const ROUTE_SHEET_KEY: InjectionKey<RouteSheet> = Symbol('routeSheet');
