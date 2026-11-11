<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { IonChip, IonIcon } from '@ionic/vue';
import { chevronDown, chevronUp, warningOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import RouteDetailsContent from '@/components/RouteDetailsContent.vue';
import { ROUTE_SHEET_KEY, useRouteDetails, useRouteDetailsView } from '@/composable/routeDetails';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import {
	headerChip,
	routeSummary,
	stretchSummary,
	type RouteSectionHost
} from '@/helper/routeDetails';

/**
 * The route section of a bottom sheet (phone layout, plan §6.8): a compact
 * header row with the basic numbers and the most important chip; a tap
 * expands it to the details (the card's content) inside the sheet, which
 * grows to its next breakpoint when it is lower than half the screen.
 * Nothing floats over the map. A tap on a coloured or dashed run of the line
 * expands it on that stretch.
 */

const props = defineProps<{ host: RouteSectionHost }>();

const { t, locale } = useI18n();
const details = useRouteDetails();
const pumpStore = usePumpCalculationStore();
const sheet = inject(ROUTE_SHEET_KEY, null);
const view = useRouteDetailsView(() => props.host);

/** Only a drawn line: the selected route, or a routed pump line. */
const visible = computed(() =>
	props.host === 'selected'
		? details.selectedRoute.value !== null
		: details.pumpSegments.value.length > 0
);

const expanded = computed(() => details.sectionState.value[props.host]);

const title = computed(() =>
	t(props.host === 'selected' ? 'route.details.title' : 'route.details.titlePump')
);

const summary = computed(() => {
	if (props.host === 'selected') {
		const route = details.selectedRoute.value;
		if (!route) return '';
		return routeSummary(route, {
			t,
			locale: locale.value,
			tubeLength: pumpStore.tubeLength,
			hoseName: pumpStore.hoseName
		});
	}
	return stretchSummary(view.value?.stretches ?? [], { t, locale: locale.value });
});

/** The pump panel shows its chips itself; the pump view has none. */
const header = computed(() => headerChip(view.value?.chips ?? []));

/** The row focus of this section's line only. */
const focusId = computed(() =>
	details.source.value === props.host ? details.focusId.value : null
);

const content = ref<InstanceType<typeof RouteDetailsContent> | null>(null);

const sectionEl = ref<HTMLElement | null>(null);

/** Grows the sheet and scrolls the focused row (else the section) into view. */
async function revealFocused() {
	if (!focusId.value) return revealSection();
	await sheet?.grow();
	await nextTick();
	await content.value?.scrollToFocused();
}

/** Grows the sheet and brings the expanded section into view. */
async function revealSection() {
	await sheet?.grow();
	await nextTick();
	sectionEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function toggle() {
	const wasExpanded = expanded.value;
	details.toggleSection(props.host);
	if (!wasExpanded) void revealSection();
}

// A tap on the line (or its badge) expands this section (composable); a
// coloured or dashed run also focuses its stretch: grow the sheet, show the row.
watch(details.focusRequest, () => {
	if (details.source.value === props.host && expanded.value) void revealFocused();
});

const bodyId = `route-section-body-${Math.random().toString(36).slice(2, 8)}`;
</script>

<template>
	<section v-if="visible && view" ref="sectionEl" class="route-sheet-section" :class="{ expanded }">
		<button
			type="button"
			class="route-sheet-header"
			:aria-expanded="expanded"
			:aria-controls="bodyId"
			@click="toggle"
		>
			<span class="header-text">
				<span class="header-title">{{ title }}</span>
				<span class="header-summary">{{ summary }}</span>
				<span v-if="header.chip || header.more > 0" class="header-chips">
					<ion-chip
						v-if="header.chip"
						:color="header.chip.color"
						:outline="header.chip.color === 'medium'"
					>
						<ion-icon v-if="header.chip.color !== 'medium'" :icon="warningOutline" />
						{{ header.chip.text }}
					</ion-chip>
					<span v-if="header.more > 0 && !expanded" class="header-more">
						{{ t('route.section.more', { count: header.more }) }}
					</span>
				</span>
			</span>
			<ion-icon class="chevron" :icon="expanded ? chevronUp : chevronDown" aria-hidden="true" />
		</button>
		<div v-if="expanded" :id="bodyId" class="route-sheet-body">
			<RouteDetailsContent
				ref="content"
				:view="view"
				:focus-id="focusId"
				:legend-open="false"
				@select="(id) => details.selectStretch(host, id)"
			/>
		</div>
	</section>
</template>

<style scoped>
.route-sheet-section {
	margin: 4px 12px 8px;
	border-radius: 12px;
	background: var(--md-sys-surface-container, rgba(var(--ion-text-color-rgb, 0, 0, 0), 0.04));
	color: var(--md-sys-on-surface, var(--ion-text-color));
}

.route-sheet-header {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	min-height: 48px;
	padding: 6px 8px 6px 12px;
	border: 0;
	border-radius: 12px;
	background: transparent;
	color: inherit;
	text-align: start;
	cursor: pointer;
}

.header-text {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.header-title {
	font: var(--md-sys-label-medium, 500 12px / 16px sans-serif);
	color: var(--md-sys-on-surface-variant, inherit);
}

.header-summary {
	font: var(--md-sys-body-large, 16px / 22px sans-serif);
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}

.header-chips {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
}

.header-chips ion-chip {
	margin: 0;
	height: 24px;
	font-size: 0.75rem;
	--padding-start: 8px;
	--padding-end: 8px;
	pointer-events: none;
}

.header-chips ion-chip ion-icon {
	margin-inline-end: 4px;
	font-size: 14px;
}

.header-more {
	font: var(--md-sys-body-small, 12px / 16px sans-serif);
	color: var(--md-sys-on-surface-variant, inherit);
}

.chevron {
	flex-shrink: 0;
	font-size: 22px;
	color: var(--md-sys-on-surface-variant, inherit);
}

.route-sheet-body {
	padding: 0 12px 12px;
}
</style>
