<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { IonButton, IonCard, IonChip, IonIcon } from '@ionic/vue';
import { chevronDown, chevronUp, close, warningOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useRouteDetails } from '@/composable/routeDetails';
import { useScreenDetection } from '@/composable/screenDetection';
import { useDefaultStore } from '@/store/defaultStore';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import {
	legendEntryOf,
	pumpLineDetailsView,
	routeDetailsView,
	type LegendEntry,
	type RouteDetailsView
} from '@/helper/routeDetails';

/**
 * The route details card (plan §6.8): opens for a drawn route and on a tap on
 * the line or its badge; a tapped coloured or dashed run opens it focused on
 * that stretch. Floats above the bottom sheet on phones (never under it, at
 * most half the screen high) and beside the side panel on desktop.
 */

const { t, locale } = useI18n();
const details = useRouteDetails();
const { isMobile } = useScreenDetection();
const { visibleMapView } = storeToRefs(useDefaultStore());
const pumpStore = usePumpCalculationStore();

const view = computed<RouteDetailsView | null>(() => {
	const options = { t, locale: locale.value };
	if (details.source.value === 'selected') {
		const route = details.selectedRoute.value;
		if (!route) return null;
		return routeDetailsView(route, {
			...options,
			tubeLength: pumpStore.tubeLength,
			hoseName: pumpStore.hoseName
		});
	}
	if (details.source.value === 'pump') {
		return pumpLineDetailsView(details.pumpSegments.value, options);
	}
	return null;
});

/** Gap kept above the FAB row when no sheet is open (FAB 56 px + margins). */
const FAB_ROW_PX = 88;
/** Room kept for the search bar at the top. */
const SEARCH_BAR_PX = 72;
/** Share of the free map height (above a sheet) the card may take on a phone. */
const PHONE_MAX_SHARE = 0.5;

const positionStyle = computed(() => {
	const view = visibleMapView.value;
	if (!isMobile.value) {
		return { left: `${view.x + 16}px`, bottom: 'calc(var(--ion-safe-area-bottom, 0px) + 16px)' };
	}
	// A bottom sheet's top edge is at `y` (of `yMax`); without one, stay above the FABs.
	const height = view.yMax > 0 ? view.yMax : window.innerHeight;
	const sheetOpen = view.y > 0 && view.y < height;
	const bottomPx = sheetOpen ? height - view.y + 8 : view.bottom + FAB_ROW_PX;
	// The map above stays mostly visible: at most half of the free height.
	const free = height - bottomPx - view.top - SEARCH_BAR_PX;
	return {
		bottom: `${bottomPx}px`,
		maxHeight: `${Math.max(140, Math.round(free * PHONE_MAX_SHARE))}px`
	};
});

/** The legend starts folded on phones (the stretch rows carry their own swatch). */
const legendOpen = ref(!isMobile.value);

const rowEls = new Map<string, HTMLElement>();
function setRowEl(id: string, el: unknown) {
	if (el) rowEls.set(id, el as HTMLElement);
	else rowEls.delete(id);
}

watch(details.focusId, async (id) => {
	if (!id) return;
	await nextTick();
	rowEls.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

/** SVG line sample for a legend entry or stretch row. */
function swatchDash(entry: LegendEntry): string | undefined {
	return entry.dashed ? '5 3' : undefined;
}

const titleId = ref(`route-details-title-${Math.random().toString(36).slice(2, 8)}`);
</script>

<template>
	<ion-card
		v-if="view"
		class="route-details"
		:class="{ mobile: isMobile }"
		:style="positionStyle"
		role="dialog"
		:aria-labelledby="titleId"
	>
		<div class="route-details-header">
			<h2 :id="titleId">{{ view.title }}</h2>
			<ion-button
				fill="clear"
				size="small"
				:title="t('route.details.close')"
				:aria-label="t('route.details.close')"
				@click="details.closeDetails()"
			>
				<ion-icon slot="icon-only" :icon="close" />
			</ion-button>
		</div>
		<div class="route-details-body">
			<dl v-if="view.rows.length > 0" class="route-rows">
				<template v-for="row in view.rows" :key="row.key">
					<dt>{{ row.label }}</dt>
					<dd>{{ row.value }}</dd>
				</template>
			</dl>
			<div v-if="view.chips.length > 0" class="route-chips">
				<ion-chip
					v-for="chip in view.chips"
					:key="chip.key"
					:color="chip.color"
					:outline="chip.color === 'medium'"
				>
					<ion-icon v-if="chip.color !== 'medium'" :icon="warningOutline" />
					{{ chip.text }}
				</ion-chip>
			</div>

			<section class="route-section">
				<h3>{{ t('route.details.stretches') }}</h3>
				<template v-if="view.stretches.length > 0">
					<button
						v-for="stretch in view.stretches"
						:key="stretch.id"
						:ref="(el) => setRowEl(stretch.id, el)"
						type="button"
						class="stretch-row"
						:class="{ focused: stretch.id === details.focusId.value }"
						:aria-pressed="stretch.id === details.focusId.value"
						@click="details.focusStretch(stretch.id)"
					>
						<svg class="swatch" viewBox="0 0 28 12" aria-hidden="true">
							<line
								x1="2"
								y1="6"
								x2="26"
								y2="6"
								:stroke="legendEntryOf(stretch.kind).color"
								stroke-width="4"
								stroke-linecap="round"
								:stroke-dasharray="swatchDash(legendEntryOf(stretch.kind))"
							/>
							<template v-if="legendEntryOf(stretch.kind).ticks">
								<line
									v-for="x in [8, 14, 20]"
									:key="x"
									:x1="x"
									y1="1"
									:x2="x"
									y2="11"
									:stroke="legendEntryOf(stretch.kind).color"
									stroke-width="1.5"
								/>
							</template>
						</svg>
						<span>{{ stretch.text }}</span>
					</button>
					<p v-if="view.directionNote" class="route-note">{{ view.directionNote }}</p>
				</template>
				<p v-else class="route-note">{{ t('route.details.noStretches') }}</p>
			</section>

			<section class="route-section">
				<button
					type="button"
					class="legend-toggle"
					:aria-expanded="legendOpen"
					@click="legendOpen = !legendOpen"
				>
					<h3>{{ t('route.details.legend') }}</h3>
					<ion-icon :icon="legendOpen ? chevronUp : chevronDown" aria-hidden="true" />
				</button>
				<ul v-if="legendOpen" class="route-legend">
					<li v-for="entry in view.legend" :key="entry.kind">
						<svg class="swatch" viewBox="0 0 28 12" aria-hidden="true">
							<line
								x1="2"
								y1="6"
								x2="26"
								y2="6"
								:stroke="entry.color"
								stroke-width="4"
								stroke-linecap="round"
								:stroke-dasharray="swatchDash(entry)"
							/>
							<template v-if="entry.ticks">
								<line
									v-for="x in [8, 14, 20]"
									:key="x"
									:x1="x"
									y1="1"
									:x2="x"
									y2="11"
									:stroke="entry.color"
									stroke-width="1.5"
								/>
							</template>
						</svg>
						<span>{{ entry.text }}</span>
					</li>
				</ul>
			</section>
		</div>
	</ion-card>
</template>

<style scoped>
.route-details {
	position: fixed;
	z-index: 1001;
	width: 360px;
	max-width: calc(100vw - 16px);
	max-height: 60vh;
	margin: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	border-radius: 16px;
	--background: var(--md-sys-surface-container-low, var(--ion-background-color));
	--color: var(--md-sys-on-surface, var(--ion-text-color));
	background: var(--background);
	color: var(--color);
	box-shadow: var(--md-sys-level3, 0 4px 16px rgba(0, 0, 0, 0.25));
}

.route-details.mobile {
	left: 8px;
	right: 8px;
	width: auto;
}

.route-details.mobile .route-rows {
	column-gap: 12px;
}

.route-details.mobile .stretch-row {
	min-height: 32px;
}

.route-details-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 4px 0 16px;
	flex-shrink: 0;
}

.route-details-header h2 {
	margin: 0;
	font: var(--md-sys-title-medium, 500 16px / 24px sans-serif);
}

.route-details-body {
	overflow-y: auto;
	padding: 0 16px 12px;
}

.route-rows {
	display: grid;
	grid-template-columns: auto 1fr;
	column-gap: 16px;
	row-gap: 2px;
	margin: 4px 0 8px;
	font: var(--md-sys-body-medium, 14px / 20px sans-serif);
}

.route-rows dt {
	color: var(--md-sys-on-surface-variant, inherit);
}

.route-rows dd {
	margin: 0;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}

.route-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-bottom: 4px;
}

.route-chips ion-chip {
	margin: 0;
	height: 26px;
	font-size: 0.8125rem;
}

.route-chips ion-icon {
	margin-inline-end: 4px;
}

.route-section {
	border-top: 1px solid var(--md-sys-outline-variant, rgba(0, 0, 0, 0.12));
	margin-top: 8px;
	padding-top: 8px;
}

.route-section h3 {
	margin: 0 0 4px;
	font: var(--md-sys-label-large, 500 14px / 20px sans-serif);
	color: var(--md-sys-on-surface-variant, inherit);
}

.stretch-row {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 36px;
	padding: 4px 8px;
	margin: 0 -8px;
	box-sizing: content-box;
	border: 0;
	border-radius: 8px;
	background: transparent;
	color: inherit;
	text-align: start;
	font: var(--md-sys-body-medium, 14px / 20px sans-serif);
	cursor: pointer;
}

.stretch-row:hover {
	background: rgba(var(--md-sys-on-surface-rgb, 0, 0, 0), 0.06);
}

.stretch-row.focused {
	background: var(--md-sys-secondary-container, rgba(51, 136, 255, 0.16));
	color: var(--md-sys-on-secondary-container, inherit);
	font-weight: 600;
}

.swatch {
	width: 28px;
	height: 12px;
	flex-shrink: 0;
}

.route-note {
	margin: 4px 0 0;
	font: var(--md-sys-body-small, 12px / 16px sans-serif);
	color: var(--md-sys-on-surface-variant, inherit);
}

.legend-toggle {
	display: flex;
	align-items: center;
	justify-content: space-between;
	width: 100%;
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--md-sys-on-surface-variant, inherit);
	cursor: pointer;
}

.legend-toggle h3 {
	margin: 0;
}

.route-legend {
	margin-top: 4px !important;
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
	gap: 2px 12px;
	font: var(--md-sys-body-small, 12px / 16px sans-serif);
}

.route-legend li {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 22px;
}
</style>
