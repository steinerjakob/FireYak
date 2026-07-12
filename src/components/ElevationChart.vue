<script setup lang="ts">
import { computed } from 'vue';
import { ElevationPoint } from '@/helper/elevationData';
import { PumpPosition } from '@/helper/calculatePumpPosition';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import pumpIcon from '@/assets/markers/markerpump.png';

const props = defineProps<{
	points: ElevationPoint[]; // resampled elevation profile, source → fire object
	pumps: PumpPosition[]; // pump placements along the profile
	totalDistance: number; // meters, x-domain max
	selected: string | null;
}>();

const emit = defineEmits<{ (e: 'select', id: string): void }>();

// viewBox geometry — everything below is computed in these units, never in
// real pixels, so the chart stays crisp at any rendered width.
const VB_WIDTH = 360;
const VB_HEIGHT = 170;
const PAD_LEFT = 36; // room for y tick labels
const PAD_RIGHT = 12;
const PAD_TOP = 24; // headroom for marker icons
const PAD_BOTTOM = 24; // room for x tick labels
const PLOT_LEFT = PAD_LEFT;
const PLOT_RIGHT = VB_WIDTH - PAD_RIGHT;
const PLOT_TOP = PAD_TOP;
const PLOT_BOTTOM = VB_HEIGHT - PAD_BOTTOM;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

const canRender = computed(() => props.points.length >= 2 && props.totalDistance > 0);

// Elevation domain: min/max padded by ~10%, or a fixed ±5 m band around the
// mean when the raw range is too flat for a padded domain to read as terrain.
const yDomain = computed(() => {
	const elevations = props.points.map((point) => point.elevation);
	const rawMin = Math.min(...elevations);
	const rawMax = Math.max(...elevations);
	const rawRange = rawMax - rawMin;
	if (rawRange < 2) {
		const mean = (rawMin + rawMax) / 2;
		return { min: mean - 5, max: mean + 5 };
	}
	const pad = rawRange * 0.1;
	return { min: rawMin - pad, max: rawMax + pad };
});

function xScale(distance: number): number {
	if (props.totalDistance <= 0) {
		return PLOT_LEFT;
	}
	return PLOT_LEFT + (distance / props.totalDistance) * PLOT_WIDTH;
}

function yScale(elevation: number): number {
	const { min, max } = yDomain.value;
	const range = max - min || 1;
	return PLOT_TOP + PLOT_HEIGHT - ((elevation - min) / range) * PLOT_HEIGHT;
}

// Smallest step from `steps` that divides `range` into at most ~4 intervals —
// keeps gridlines/ticks to a handful of round numbers regardless of scale.
function niceStepFor(range: number, steps: number[]): number {
	for (const step of steps) {
		if (range / step <= 4) {
			return step;
		}
	}
	return steps[steps.length - 1];
}

function multiplesInRange(min: number, max: number, step: number): number[] {
	const values: number[] = [];
	const first = Math.ceil(min / step) * step;
	for (let value = first; value <= max + 1e-6; value += step) {
		values.push(Math.round(value * 1000) / 1000);
	}
	return values;
}

// Evenly sample down to `desired` entries so dense multiples (e.g. every 5 m
// over a 200 m range) don't turn into a wall of gridlines.
function sampleValues(values: number[], desired: number): number[] {
	if (values.length <= desired || desired <= 1) {
		return values;
	}
	const sampled = new Set<number>();
	for (let i = 0; i < desired; i++) {
		const index = Math.round((i * (values.length - 1)) / (desired - 1));
		sampled.add(values[index]);
	}
	return Array.from(sampled);
}

const yTicks = computed(() => {
	const { min, max } = yDomain.value;
	const step = niceStepFor(max - min, [5, 10, 20, 50, 100, 200, 500]);
	const candidates = multiplesInRange(min, max, step);
	const values = sampleValues(candidates, 3);
	if (values.length === 0) {
		values.push(Math.round((min + max) / 2));
	}
	const maxValue = Math.max(...values);
	return values
		.slice()
		.sort((a, b) => a - b)
		.map((value) => ({
			value,
			y: yScale(value),
			label: value === maxValue ? `${Math.round(value)} m` : `${Math.round(value)}`
		}));
});

const xTicks = computed(() => {
	const step = niceStepFor(props.totalDistance, [100, 250, 500, 1000, 2000, 5000, 10000]);
	const values: number[] = [0];
	for (let value = step; value <= props.totalDistance; value += step) {
		values.push(value);
	}
	if (values.length < 2) {
		values.push(Math.round(props.totalDistance));
	}

	const lastValue = values[values.length - 1];
	const lastX = xScale(lastValue);
	// Drop any tick that would crowd the final one (labels are ~24 units wide).
	const filtered = values.filter((value, index) => {
		if (index === values.length - 1) {
			return true;
		}
		return Math.abs(xScale(value) - lastX) > 28;
	});

	return filtered.map((value, index) => ({
		value,
		x: xScale(value),
		label: index === filtered.length - 1 ? `${Math.round(value)} m` : `${Math.round(value)}`
	}));
});

const profilePoints = computed(() =>
	props.points.map((point) => ({ x: xScale(point.distance ?? 0), y: yScale(point.elevation) }))
);

const linePath = computed(() =>
	profilePoints.value
		.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
		.join(' ')
);

const areaPath = computed(() => {
	const points = profilePoints.value;
	if (points.length === 0) {
		return '';
	}
	const first = points[0];
	const last = points[points.length - 1];
	return `${linePath.value} L ${last.x.toFixed(2)} ${PLOT_BOTTOM} L ${first.x.toFixed(2)} ${PLOT_BOTTOM} Z`;
});

interface ChartMarker {
	id: string;
	x: number;
	y: number;
	elevation: number;
	icon: string;
}

const markers = computed<ChartMarker[]>(() => {
	if (props.points.length === 0) {
		return [];
	}
	const first = props.points[0];
	const last = props.points[props.points.length - 1];

	const result: ChartMarker[] = [
		{
			id: 'suction',
			x: xScale(0),
			y: yScale(first.elevation),
			elevation: first.elevation,
			icon: suctionPointIcon
		}
	];

	props.pumps.forEach((pump, index) => {
		result.push({
			id: `pump-${index}`,
			x: xScale(pump.distanceFromStart),
			y: yScale(pump.elevation),
			elevation: pump.elevation,
			icon: pumpIcon
		});
	});

	result.push({
		id: 'target',
		x: xScale(last.distance ?? props.totalDistance),
		y: yScale(last.elevation),
		elevation: last.elevation,
		icon: firepointIcon
	});

	return result;
});

function selectMarker(id: string) {
	emit('select', id);
}
</script>

<template>
	<svg v-if="canRender" viewBox="0 0 360 170" style="width: 100%; height: auto; display: block">
		<line
			v-for="tick in yTicks"
			:key="`grid-${tick.value}`"
			:x1="PLOT_LEFT"
			:x2="PLOT_RIGHT"
			:y1="tick.y"
			:y2="tick.y"
			class="gridline"
		/>

		<text
			v-for="tick in yTicks"
			:key="`y-label-${tick.value}`"
			:x="PLOT_LEFT - 6"
			:y="tick.y + 3"
			class="tick-label"
			text-anchor="end"
		>
			{{ tick.label }}
		</text>

		<text
			v-for="tick in xTicks"
			:key="`x-label-${tick.value}`"
			:x="tick.x"
			:y="PLOT_BOTTOM + 16"
			class="tick-label"
			text-anchor="middle"
		>
			{{ tick.label }}
		</text>

		<path :d="areaPath" class="area-path" />
		<path :d="linePath" class="line-path" />

		<g v-for="marker in markers" :key="marker.id">
			<circle
				v-if="selected === marker.id"
				:cx="marker.x"
				:cy="marker.y"
				r="10"
				class="selection-highlight"
			/>
			<circle :cx="marker.x" :cy="marker.y" r="3" class="marker-dot" aria-hidden="true" />
			<image
				:href="marker.icon"
				:x="marker.x - 9"
				:y="marker.y - 18"
				width="18"
				height="18"
				aria-hidden="true"
			/>
			<circle
				:cx="marker.x"
				:cy="marker.y"
				r="14"
				class="hit-target"
				role="button"
				tabindex="0"
				:aria-label="marker.id"
				@click="selectMarker(marker.id)"
				@keydown.enter="selectMarker(marker.id)"
				@keydown.space.prevent="selectMarker(marker.id)"
			>
				<title>{{ Math.round(marker.elevation) }} m</title>
			</circle>
		</g>
	</svg>
</template>

<style scoped>
.gridline {
	stroke: var(--md-sys-outline-variant);
	stroke-width: 1;
}

.tick-label {
	font-size: 9px;
	fill: var(--md-sys-on-surface-variant);
}

.area-path {
	fill: var(--md-sys-primary);
	fill-opacity: 0.1;
	stroke: none;
}

.line-path {
	fill: none;
	stroke: var(--md-sys-primary);
	stroke-width: 2;
	stroke-linejoin: round;
	stroke-linecap: round;
}

.selection-highlight {
	fill: var(--md-sys-primary);
	fill-opacity: 0.18;
	stroke: var(--md-sys-primary);
	stroke-width: 1.5;
}

.marker-dot {
	fill: var(--md-sys-primary);
	stroke: var(--md-sys-surface);
	stroke-width: 2;
}

.hit-target {
	fill: transparent;
	cursor: pointer;
	pointer-events: all;
}
</style>
