<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { IonChip, IonIcon } from '@ionic/vue';
import { chevronDown, chevronUp, warningOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { legendEntryOf, type LegendEntry, type RouteDetailsView } from '@/helper/routeDetails';

/**
 * The details of a route line (plan §6.8): rows, chips, the coloured
 * stretches (a row tap focuses one) and the legend. Shared by the floating
 * card (desktop) and the route section of a bottom sheet (phone); the view
 * model comes from `src/helper/routeDetails.ts`.
 */

const props = defineProps<{
	view: RouteDetailsView;
	/** The focused stretch's id (highlighted, scrolled into view). */
	focusId: string | null;
	/** Whether the legend starts unfolded. */
	legendOpen?: boolean;
}>();

const emit = defineEmits<{ select: [id: string] }>();

const { t } = useI18n();

const legendShown = ref(props.legendOpen ?? true);

const rowEls = new Map<string, HTMLElement>();
function setRowEl(id: string, el: unknown) {
	if (el) rowEls.set(id, el as HTMLElement);
	else rowEls.delete(id);
}

/** Scrolls the focused stretch's row into view (inside the card or the sheet). */
async function scrollToFocused() {
	if (!props.focusId) return;
	await nextTick();
	rowEls.get(props.focusId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

watch(() => props.focusId, scrollToFocused, { immediate: true });

defineExpose({ scrollToFocused });

/** SVG line sample for a legend entry or stretch row. */
function swatchDash(entry: LegendEntry): string | undefined {
	return entry.dashed ? '5 3' : undefined;
}
</script>

<template>
	<div class="route-details-content">
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
					:class="{ focused: stretch.id === focusId }"
					:aria-pressed="stretch.id === focusId"
					@click="emit('select', stretch.id)"
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
				:aria-expanded="legendShown"
				@click="legendShown = !legendShown"
			>
				<h3>{{ t('route.details.legend') }}</h3>
				<ion-icon :icon="legendShown ? chevronUp : chevronDown" aria-hidden="true" />
			</button>
			<ul v-if="legendShown" class="route-legend">
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
</template>

<style scoped>
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
	list-style: none;
	margin: 4px 0 0;
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
