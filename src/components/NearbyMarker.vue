<script setup lang="ts">
import {
	IonAccordion,
	IonAccordionGroup,
	IonChip,
	IonIcon,
	IonItem,
	IonLabel,
	IonList,
	IonSpinner
} from '@ionic/vue';
import { chevronDown } from 'ionicons/icons';

import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { useI18n } from 'vue-i18n';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import { coerceRef, toRef } from '@/helper/osmRef';
import { markerTitleKey } from '@/helper/markerTitle';
import { formatMeters, routeChips } from '@/helper/routeLabel';
import RouteDetailsContent from '@/components/RouteDetailsContent.vue';
import { ROUTE_SHEET_KEY, useRouteDetails, useRouteDetailsView } from '@/composable/routeDetails';
import { rowExpansionAfter, rowRouteState } from '@/helper/routeDetails';

const { list, updatedRefs, markInteraction } = useNearbyWaterSource();
const router = useRouter();
const route = useRoute();
const { t, locale } = useI18n();
const pumpCalculationStore = usePumpCalculationStore();

const getTitle = (markerData: OverPassElement) => {
	if (!markerData) return t('markerInfo.title.locationInfo');

	const name = markerData.tags?.name;
	if (name) return name;
	return t(markerTitleKey(markerData.tags));
};

const getBTubes = (distance: number) => {
	const tubes = t('pumpCalculation.pump.tubes');
	const neededBTubes = Math.ceil(distance / pumpCalculationStore.tubeLength);
	return `~${neededBTubes} ${pumpCalculationStore.hoseName}-${tubes}`;
};

const getDistanceText = (distance: number) => {
	// Metres like the map label (the same number for a routed line).
	const text = `${t('route.estimate', { distance: formatMeters(distance, locale.value) })} ${t('nearbyMarker.away')}`;
	return `${text} ${getBTubes(distance)}`;
};

const formattedList = computed(() => {
	return list.value.map((nearbyMarker) => {
		// Prefer the routed length: that is the length the hoses actually have
		// to cover (and what the B-tube count is for) and what the map label shows.
		const displayDistance = nearbyMarker.routedDistance ?? nearbyMarker.distance;
		return {
			ref: toRef(nearbyMarker.element.type, nearbyMarker.element.id),
			title: getTitle(nearbyMarker.element),
			icon: nearbyMarker.icon,
			distance: nearbyMarker.distance,
			distanceText: getDistanceText(displayDistance),
			chips: routeChips(nearbyMarker.route, nearbyMarker.fallback)
		};
	});
});

// Coerced, not compared raw: a legacy shared link still routes here as a bare
// number (`/nearbysources/123`), which would never match the `n123` refs the
// list items now carry.
const selectedMarkerRef = computed(() => {
	const param = Array.isArray(route.params.markerId)
		? route.params.markerId[0]
		: route.params.markerId;
	return param ? coerceRef(param) : null;
});

/*
 * The selected entry's row expands in place to its route details (owner
 * feedback, plan §6.8): a section above the list scrolled away. Phone and
 * side panel alike. A tap on a row only selects it; the arrow button at the
 * end of the selected row expands and collapses it (`rowExpansionAfter`).
 */
const details = useRouteDetails();
const sheet = inject(ROUTE_SHEET_KEY, null);
const view = useRouteDetailsView(() => 'selected');

/** The expanded row (only ever the selected one), for as long as the list is open. */
const expandedRef = ref<string | null>(null);

const expandedState = computed(() =>
	expandedRef.value
		? rowRouteState(expandedRef.value, {
				routeRef: details.selectedRouteRef.value,
				hasRoute: details.selectedRoute.value !== null,
				pendingRef: details.pendingRouteRef.value
			})
		: null
);

/** The expanded row shows the details (its own compact chips would repeat them). */
const showsDetails = computed(
	() => expandedState.value === 'ready' || expandedState.value === 'updating'
);

const focusId = computed(() =>
	details.source.value === 'selected' ? details.focusId.value : null
);

/** Plain wrapper of the accordion group: its rows are found by `data-ref`. */
const groupEl = ref<HTMLElement | null>(null);
function rowElement(id: string): HTMLElement | null {
	return (
		Array.from(groupEl.value?.querySelectorAll<HTMLElement>('ion-accordion') ?? []).find(
			(el) => el.dataset.ref === id
		) ?? null
	);
}

const content = ref<InstanceType<typeof RouteDetailsContent> | null>(null);
function setContent(el: unknown) {
	content.value = el as InstanceType<typeof RouteDetailsContent> | null;
}

const ACCORDION_SETTLE_MS = 320;

/** Grows the sheet (phone) and brings the expanded row into view. */
async function revealRow() {
	const id = expandedRef.value;
	if (!id) return;
	await sheet?.grow();
	await nextTick();
	// The accordion animates its height open; scroll once it has settled.
	await new Promise((resolve) => setTimeout(resolve, ACCORDION_SETTLE_MS));
	rowElement(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** A tap on a row only selects it (the route is drawn, the URL follows). */
function onRowTap(id: string) {
	if (id !== selectedMarkerRef.value) void router.push(`/nearbysources/${id}`);
}

/** The arrow button of the selected row expands or collapses its details. */
function onToggle(id: string) {
	expandedRef.value = rowExpansionAfter(expandedRef.value, selectedMarkerRef.value, {
		type: 'toggle',
		ref: id
	});
	if (expandedRef.value) void revealRow();
}

// A new selection (row tap, marker tap, link) starts collapsed; the previous row collapses.
watch(selectedMarkerRef, (id, before) => {
	expandedRef.value = id
		? rowExpansionAfter(expandedRef.value, before, { type: 'select', ref: id })
		: null;
});

// The details replaced the loading note: the taller row may need scrolling.
watch(expandedState, (state, before) => {
	if (state === 'ready' && before === 'loading') void revealRow();
});

// A tap on the line or its badge expands the selected row; a coloured or
// dashed run also focuses its stretch row.
watch(details.focusRequest, async () => {
	const selected = selectedMarkerRef.value;
	if (details.source.value !== 'selected' || !selected) return;
	expandedRef.value = rowExpansionAfter(expandedRef.value, selected, {
		type: 'stretch',
		ref: selected
	});
	await revealRow();
	if (focusId.value) await content.value?.scrollToFocused();
});
</script>

<template>
	<!-- Touch, scroll and wheel mark the list as in use: a silent recompute
	     then updates the metres but keeps the order until it is left alone. -->
	<ion-list
		class="info-list"
		@touchstart.passive="markInteraction"
		@pointerdown="markInteraction"
		@wheel.passive="markInteraction"
	>
		<!-- Nearby Water Sources; the arrow of the selected row opens its route details. -->
		<div ref="groupEl">
			<ion-accordion-group :value="expandedRef ?? ''">
				<ion-accordion
					v-for="item in formattedList"
					:key="item.ref"
					:value="item.ref"
					:data-ref="item.ref"
					class="nearby-row"
				>
					<ion-item
						slot="header"
						lines="inset"
						:detail="false"
						:class="{
							selected: selectedMarkerRef === item.ref,
							updated: updatedRefs.has(item.ref)
						}"
						@click.stop="onRowTap(item.ref)"
					>
						<img slot="start" :src="item.icon" style="height: 24px" alt="Target marker" />
						<ion-label>
							<h3>{{ item.title }}</h3>
							<p>{{ item.distanceText }}</p>
							<div
								v-if="item.chips.length > 0 && !(expandedRef === item.ref && showsDetails)"
								class="route-chips"
							>
								<ion-chip
									v-for="chip in item.chips"
									:key="chip.key"
									:color="chip.color"
									:outline="chip.color === 'medium'"
								>
									{{ t(chip.key) }}
								</ion-chip>
							</div>
						</ion-label>
					</ion-item>
					<!-- A sibling of the item (no button inside a button), laid over its end:
					     only the selected row has it. The click must not reach the accordion
					     header (its own toggle is never used; the state is ours). -->
					<button
						v-if="selectedMarkerRef === item.ref"
						slot="header"
						type="button"
						class="row-toggle"
						:aria-expanded="expandedRef === item.ref"
						:aria-label="
							t(
								expandedRef === item.ref ? 'route.section.hideDetails' : 'route.section.showDetails'
							)
						"
						@click.stop="onToggle(item.ref)"
					>
						<ion-icon :icon="chevronDown" aria-hidden="true" />
					</button>
					<div slot="content" class="row-details">
						<template v-if="expandedRef === item.ref && expandedState">
							<div v-if="expandedState === 'loading'" class="row-status" role="status">
								<ion-spinner name="crescent" />
								<span>{{ t('route.section.loading') }}</span>
							</div>
							<p v-else-if="expandedState === 'none' || !view" class="row-status">
								{{ t('route.section.noRoute') }}
							</p>
							<template v-else>
								<span
									v-if="expandedState === 'updating'"
									class="row-updating"
									role="status"
									:title="t('route.section.updating')"
									:aria-label="t('route.section.updating')"
								>
									<ion-spinner name="crescent" />
								</span>
								<RouteDetailsContent
									:ref="setContent"
									:view="view"
									:focus-id="focusId"
									:legend-open="false"
									@select="(id) => details.selectStretch('selected', id)"
								/>
							</template>
						</template>
					</div>
				</ion-accordion>
			</ion-accordion-group>
		</div>
	</ion-list>
</template>

<style scoped>
.info-list {
	background: transparent;
	padding-top: 4px;
}

ion-item {
	--background: transparent;
	--padding-start: 12px;
	--padding-end: 12px;
	--inner-padding-end: 0;
	--min-height: 48px;
}

ion-icon {
	font-size: 20px;
	margin-right: 8px;
}

ion-label h3 {
	font-weight: 600;
	font-size: 0.875rem;
	margin-bottom: 2px;
}

ion-label p {
	font-size: 1rem !important;
	margin-top: 0;
}

.route-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-top: 2px;
}

.route-chips ion-chip {
	margin: 0;
	height: 22px;
	font-size: 0.75rem;
	--padding-start: 8px;
	--padding-end: 8px;
}

/* Flat full-width rows like the plain list: not the md3 theme's accordion card
   (`:root` only raises the specificity over `theme/md3/ionic/accordion.css`). */
:root .info-list ion-accordion-group {
	margin: 0;
	border: 0;
	border-radius: 0;
	background: transparent;
	color: inherit;
}

ion-accordion {
	background: transparent;
}

/* The accordion's own toggle icon and header tap are not used: a tap on a row
   only selects it, the arrow button below expands the selected row. */
ion-item:deep(.ion-accordion-toggle-icon) {
	display: none;
}

/* The header part is the arrow button's positioning box (the item's height). */
ion-accordion::part(header) {
	position: relative;
}

ion-item.selected {
	--inner-padding-end: 44px;
}

.row-toggle {
	position: absolute;
	top: 50%;
	right: 2px;
	transform: translateY(-50%);
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	padding: 0;
	border: 0;
	border-radius: 50%;
	background: transparent;
	color: var(--ion-color-primary);
	cursor: pointer;
	-webkit-tap-highlight-color: transparent;
}

.row-toggle:hover {
	background: rgba(var(--ion-color-primary-rgb), 0.12);
}

.row-toggle:focus-visible {
	outline: 2px solid var(--ion-color-primary);
	outline-offset: -2px;
}

.row-toggle ion-icon {
	margin: 0;
	font-size: 24px;
	transition: transform 300ms cubic-bezier(0.25, 0.8, 0.5, 1);
}

.row-toggle[aria-expanded='true'] ion-icon {
	transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
	.row-toggle ion-icon {
		transition: none;
	}
}

/* The expanded details: no left bar (the header row keeps the selected style). */
.row-details {
	position: relative;
	padding: 0 12px 12px;
	background: rgba(var(--ion-color-primary-rgb), 0.06);
	color: var(--md-sys-on-surface, var(--ion-text-color));
}

.row-status {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 40px;
	margin: 0;
	font: var(--md-sys-body-medium, 14px / 20px sans-serif);
	color: var(--md-sys-on-surface-variant, inherit);
}

.row-status ion-spinner,
.row-updating ion-spinner {
	width: 18px;
	height: 18px;
}

/* A recompute of the shown route: a small spinner, nothing moves. */
.row-updating {
	position: absolute;
	top: 6px;
	right: 12px;
}

.loading-note {
	padding: 12px;
	display: block;
}

/* Selected entry: highlight on every platform (items use <img>, not ion-icon,
   so tinting the icon alone would leave iOS without any visible highlight).
   The accent bar marks the row itself; the expanded details below have none. */
ion-item.selected {
	--background: rgba(var(--ion-color-primary-rgb), 0.14);
	border-left: 3px solid var(--ion-color-primary);
}
/* A silent recompute changed this entry's metres (late map data). */
ion-item.updated {
	animation: route-updated 1.2s ease-out;
}
@keyframes route-updated {
	0%,
	40% {
		--background: rgba(var(--ion-color-warning-rgb), 0.28);
	}
	100% {
		--background: transparent;
	}
}
ion-item.selected h3 {
	color: var(--ion-color-primary);
}
</style>
