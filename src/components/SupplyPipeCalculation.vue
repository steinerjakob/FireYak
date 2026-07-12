<script setup lang="ts">
import { computed, watch } from 'vue';
import {
	IonButton,
	IonChip,
	IonIcon,
	IonInput,
	IonItem,
	IonLabel,
	IonList,
	IonSelect,
	IonSelectOption
} from '@ionic/vue';
import { calculator, cloudOfflineOutline, locate } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { usePumpCalculation, type ResultEntryId } from '@/composable/pumpCalculation';
import ElevationChart from '@/components/ElevationChart.vue';
import type { PumpPosition } from '@/helper/calculatePumpPosition';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import wayPointIcon from '@/assets/markers/waypoint.png';
import pumpIcon from '@/assets/markers/markerpump.png'; // Add pump icon import
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';

const { t } = useI18n();
const pumpCalculation = usePumpCalculation();
const pumpCalculationStore = usePumpCalculationStore();

const calculationAllowed = computed(() => {
	return pumpCalculation.firePointSet.value && pumpCalculation.suctionPointSet.value;
});

const flowRateChanged = (event: CustomEvent) => {
	pumpCalculationStore.pressureLost = Number(event.detail.value);
};

const inputPressureChanged = (event: CustomEvent) => {
	const value = event.detail.value;
	pumpCalculationStore.inputPressure = Number(value);
};

const outputPressureChanged = (event: CustomEvent) => {
	const value = event.detail.value;
	pumpCalculationStore.outputPressure = Number(value);
};

const targetPressureChanged = (event: CustomEvent) => {
	pumpCalculationStore.targetPressure = Number(event.detail.value);
};

const tubeCount = computed(() => {
	return Math.ceil(
		(pumpCalculation.calculationResult.value?.realDistance || 0) / pumpCalculationStore.tubeLength
	);
});

// Reserve material per doctrine: 1 spare B-hose per 100 m of line,
// 1 spare pump per 4 pumps in use.
const reserveTubes = computed(() => {
	return Math.ceil((pumpCalculation.calculationResult.value?.realDistance || 0) / 100);
});

const reservePumps = computed(() => {
	return Math.ceil((pumpCalculation.calculationResult.value?.pumpCount || 0) / 4);
});

function formatSignedMeters(value: number): string {
	if (value > 0) return `+${value} m`;
	if (value < 0) return `${value} m`;
	return '±0 m';
}

function formatRise(value: number): string {
	if (value > 0) return `↑${value} m`;
	if (value < 0) return `↓${Math.abs(value)} m`;
	return '±0 m';
}

const elevationDiffLabel = computed(() => {
	const result = pumpCalculation.calculationResult.value;
	return result ? formatSignedMeters(result.elevation) : '';
});

const suctionInfo = computed(() => {
	const result = pumpCalculation.calculationResult.value;
	if (!result) return '';
	return result.sourcePressure !== null
		? t('pumpCalculation.sourcePressureUsed', { pressure: result.sourcePressure })
		: t('pumpCalculation.sourcePumpRequired');
});

// Same "hoses / distance / rise / pressure" shape as a pump entry, derived
// for the last leg (last pump, or the suction point when there is none) to
// the fire object.
const fireObjectEntry = computed(() => {
	const result = pumpCalculation.calculationResult.value;
	if (!result) return null;

	const lastPump = result.pumpPositions[result.pumpPositions.length - 1];
	const distance = result.realDistance - (lastPump?.distanceFromStart ?? 0);
	const neededBTubes = Math.ceil(distance / pumpCalculationStore.tubeLength);
	const lastElevation = result.elevationData[result.elevationData.length - 1];
	const rise = Math.round(
		lastElevation.elevation - (lastPump?.elevation ?? result.elevationData[0].elevation)
	);
	const pressure = lastElevation.pressure ?? 0;

	return { neededBTubes, distance, rise, pressure };
});

// `PumpPosition.marker` is a maplibregl.Marker, whose declaration types are
// self-referential (Map <-> Marker); re-deriving the array's type across the
// ElevationChart SFC prop boundary makes TS re-expand that recursive shape
// and fail structurally even though it's the same PumpPosition[] on both
// sides. The `unknown` cast sidesteps that recursive structural check.
const chartPumpPositions = computed(
	() => (pumpCalculation.calculationResult.value?.pumpPositions ?? []) as unknown as PumpPosition[]
);

function pumpEntryId(index: number): ResultEntryId {
	return `pump-${index}`;
}

function isSelected(id: ResultEntryId): boolean {
	return pumpCalculation.selectedResultEntry.value === id;
}

function selectEntry(id: ResultEntryId) {
	pumpCalculation.selectResultEntry(id, { center: true });
}

// Result-row elements keyed by entry id, so the panel can scroll a row into
// view when the selection changes from elsewhere (map marker tap, chart tap).
const rowRefs = new Map<ResultEntryId, HTMLElement>();

function setRowRef(id: ResultEntryId, el: unknown) {
	if (!el) {
		rowRefs.delete(id);
		return;
	}
	const node = (el as { $el?: HTMLElement }).$el ?? (el as HTMLElement);
	rowRefs.set(id, node);
}

watch(pumpCalculation.selectedResultEntry, (id) => {
	if (!id) return;
	rowRefs.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
</script>

<template>
	<ion-list v-if="!pumpCalculation.calculationResult.value" class="info-list">
		<!-- Coordinates -->
		<ion-item button @click="pumpCalculation.setTargetPoint()" :detail="false">
			<img slot="start" :src="firepointIcon" style="height: 24px" alt="Fire point" />
			<ion-label>
				{{ t('pumpCalculation.fireObject') }}
			</ion-label>
			<ion-button
				slot="end"
				@click="pumpCalculation.setTargetPoint()"
				:color="pumpCalculation.firePointSet.value ? 'medium' : 'primary'"
			>
				<ion-icon :icon="locate" slot="end"></ion-icon>
				<template v-if="pumpCalculation.firePointSet.value">
					{{ t('pumpCalculation.updatePosition') }}
				</template>
				<template v-else>
					{{ t('pumpCalculation.setPosition') }}
				</template>
			</ion-button>
		</ion-item>
		<ion-item button @click="pumpCalculation.setSuctionPoint()" :detail="false">
			<img slot="start" :src="suctionPointIcon" style="height: 24px" alt="Suction point" />
			<ion-label>
				{{ t('pumpCalculation.suctionPoint') }}
			</ion-label>
			<ion-button
				slot="end"
				@click="pumpCalculation.setSuctionPoint()"
				:color="pumpCalculation.suctionPointSet.value ? 'medium' : 'primary'"
			>
				<ion-icon :icon="locate" slot="end"></ion-icon>
				<template v-if="pumpCalculation.suctionPointSet.value">
					{{ t('pumpCalculation.updatePosition') }}
				</template>
				<template v-else>
					{{ t('pumpCalculation.setPosition') }}
				</template>
			</ion-button>
		</ion-item>
		<ion-item button @click="pumpCalculation.setWayPoint()" :detail="false">
			<img slot="start" :src="wayPointIcon" style="height: 24px" alt="Waypoint" />
			<ion-label>
				{{ t('pumpCalculation.wayPoint') }}
			</ion-label>
			<ion-button slot="end" @click="pumpCalculation.setWayPoint()">
				{{ t('pumpCalculation.setPosition') }}
				<ion-icon :icon="locate" slot="end"></ion-icon>
			</ion-button>
		</ion-item>
		<ion-item>
			<!-- Friction loss per 100 m B-hose by flow rate (HLFS Tab. 2) -->
			<ion-select
				:label="t('pumpCalculation.pump.flowRate')"
				placeholder="Make a Selection"
				:value="pumpCalculationStore.pressureLost.toString()"
				@ionChange="flowRateChanged"
			>
				<ion-select-option value="0.3">400 l/min</ion-select-option>
				<ion-select-option value="0.6">600 l/min</ion-select-option>
				<ion-select-option value="1">800 l/min</ion-select-option>
				<ion-select-option value="1.4">1000 l/min</ion-select-option>
				<ion-select-option value="2">1200 l/min</ion-select-option>
				<ion-select-option value="4">1600 l/min</ion-select-option>
			</ion-select>
		</ion-item>
		<ion-item>
			<ion-input
				:label="t('pumpCalculation.pump.inputPressure')"
				label-placement="stacked"
				type="number"
				inputmode="decimal"
				:value="pumpCalculationStore.inputPressure"
				@ionChange="inputPressureChanged"
			></ion-input>
		</ion-item>
		<ion-item>
			<ion-input
				:label="t('pumpCalculation.pump.outputPressure')"
				label-placement="stacked"
				type="number"
				inputmode="decimal"
				:value="pumpCalculationStore.outputPressure"
				@ionChange="outputPressureChanged"
			></ion-input>
		</ion-item>
		<ion-item>
			<ion-input
				:label="t('pumpCalculation.pump.targetPressure')"
				label-placement="stacked"
				type="number"
				inputmode="decimal"
				:value="pumpCalculationStore.targetPressure"
				@ionChange="targetPressureChanged"
			></ion-input>
		</ion-item>
		<ion-button
			expand="block"
			class="ion-margin-top ion-margin-horizontal"
			@click="pumpCalculation.calculatePumpRequirements()"
			:disabled="!calculationAllowed"
		>
			<ion-icon :icon="calculator" slot="start"></ion-icon>
			{{ t('pumpCalculation.buttons.calculate') }}
		</ion-button>
	</ion-list>

	<ion-list v-else>
		<ion-item v-if="pumpCalculation.calculationResult.value.elevationIgnored" lines="none">
			<ion-chip color="warning" class="elevation-ignored-chip">
				<ion-icon :icon="cloudOfflineOutline"></ion-icon>
				{{ t('pumpCalculation.elevationIgnored') }}
			</ion-chip>
		</ion-item>

		<!-- Summary stat grid -->
		<ion-item lines="none">
			<ion-label>
				<div class="stat-grid">
					<div class="stat-tile">
						<div class="stat-label">
							{{ pumpCalculationStore.hoseName }}-{{ t('pumpCalculation.pump.tubes') }}
						</div>
						<div class="stat-value">~{{ tubeCount }}</div>
					</div>
					<div class="stat-tile">
						<div class="stat-label">{{ t('pumpCalculation.pump.title') }}</div>
						<div class="stat-value">~{{ pumpCalculation.calculationResult.value.pumpCount }}</div>
					</div>
					<div class="stat-tile">
						<div class="stat-label">{{ t('pumpCalculation.pump.distanceFromStart') }}</div>
						<div class="stat-value">
							~{{ pumpCalculation.calculationResult.value.realDistance.toFixed(0) }} m
						</div>
					</div>
					<div class="stat-tile">
						<div class="stat-label">{{ t('pumpCalculation.pump.elevationDifference') }}</div>
						<div class="stat-value">{{ elevationDiffLabel }}</div>
					</div>
				</div>
				<div class="reserve-row">
					<span class="reserve-label">{{ t('pumpCalculation.pump.reserve') }}:</span>
					<span class="reserve-value"
						>+{{ reserveTubes }} {{ pumpCalculationStore.hoseName }}-{{
							t('pumpCalculation.pump.tubes')
						}}
						· +{{ reservePumps }} {{ t('pumpCalculation.pump.title') }}</span
					>
				</div>
			</ion-label>
		</ion-item>

		<!-- Elevation profile -->
		<ion-item
			v-if="
				pumpCalculation.calculationResult.value.elevationData.length > 1 &&
				!pumpCalculation.calculationResult.value.elevationIgnored
			"
			lines="none"
			class="chart-item"
		>
			<ion-label>
				<div class="section-subheader">{{ t('pumpCalculation.chart.title') }}</div>
				<ElevationChart
					:points="pumpCalculation.calculationResult.value.elevationData"
					:pumps="chartPumpPositions"
					:total-distance="pumpCalculation.calculationResult.value.realDistance"
					:selected="pumpCalculation.selectedResultEntry.value"
					@select="(id) => selectEntry(id as ResultEntryId)"
				/>
			</ion-label>
		</ion-item>

		<!-- Entry list, source → fire object (matches the chart's left-to-right
		     order). Tapping a row selects the matching map marker/chart point;
		     the reverse (marker tap, chart tap) highlights + scrolls the row
		     into view, see the `watch` above. -->
		<ion-item
			button
			:class="{ 'entry-selected': isSelected('suction') }"
			:ref="(el) => setRowRef('suction', el)"
			@click="selectEntry('suction')"
		>
			<img slot="start" :src="suctionPointIcon" style="height: 24px" alt="Suction marker" />
			<ion-label>
				<h3>{{ t('pumpCalculation.suctionPoint') }}</h3>
				<p>{{ suctionInfo }}</p>
			</ion-label>
		</ion-item>

		<template
			v-for="(position, index) in pumpCalculation.calculationResult.value.pumpPositions"
			:key="position.distanceFromStart"
		>
			<ion-item
				button
				:class="{ 'entry-selected': isSelected(pumpEntryId(index)) }"
				:ref="(el) => setRowRef(pumpEntryId(index), el)"
				@click="selectEntry(pumpEntryId(index))"
			>
				<img slot="start" :src="pumpIcon" style="height: 24px" alt="Pump marker" />
				<ion-label>
					<h3>{{ t('pumpCalculation.pump.numbered', { n: index + 1 }) }}</h3>
					<p>
						~{{ position.neededBTubes }} {{ pumpCalculationStore.hoseName }}-{{
							t('pumpCalculation.pump.tubes')
						}}
						· ~{{ position.distanceFromPrev }} m · {{ formatRise(position.riseFromPrev) }}
					</p>
					<p>
						{{ t('pumpCalculation.pump.inputPressureShort') }}:
						{{ position.pressureAtTrigger.toFixed(1) }}
						bar
					</p>
				</ion-label>
			</ion-item>
		</template>

		<ion-item
			v-if="fireObjectEntry"
			button
			:class="{ 'entry-selected': isSelected('target') }"
			:ref="(el) => setRowRef('target', el)"
			@click="selectEntry('target')"
		>
			<img slot="start" :src="firepointIcon" style="height: 24px" alt="Target marker" />
			<ion-label>
				<h3>{{ t('pumpCalculation.fireObject') }}</h3>
				<p>
					~{{ fireObjectEntry.neededBTubes }} {{ pumpCalculationStore.hoseName }}-{{
						t('pumpCalculation.pump.tubes')
					}}
					· ~{{ fireObjectEntry.distance.toFixed(0) }} m · {{ formatRise(fireObjectEntry.rise) }}
				</p>
				<p>
					{{ t('pumpCalculation.pump.inputPressureShort') }}:
					{{ fireObjectEntry.pressure.toFixed(1) }}
					bar
				</p>
			</ion-label>
		</ion-item>
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

.stat-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
	width: 100%;
}

.stat-tile {
	background: var(--md-sys-surface-container);
	border-radius: 12px;
	padding: 10px 12px;
}

.stat-label {
	font-size: 12px;
	color: var(--md-sys-on-surface-variant);
}

.stat-value {
	font-size: 18px;
	font-weight: 600;
	color: var(--md-sys-on-surface);
	margin-top: 2px;
}

.reserve-row {
	width: 100%;
	margin-top: 8px;
	display: flex;
	justify-content: space-between;
	align-items: center;
	font-size: 13px;
}

.reserve-label {
	font-weight: bold;
}

.section-subheader {
	font-size: 13px;
	font-weight: 600;
	color: var(--md-sys-on-surface-variant);
	margin-bottom: 6px;
}

.chart-item {
	--padding-top: 8px;
	--padding-bottom: 8px;
}

.entry-selected {
	--background: var(--md-sys-secondary-container);
	color: var(--md-sys-on-secondary-container);
	border-radius: 12px;
}

.elevation-ignored-chip {
	font-weight: 600;
}

.elevation-ignored-chip ion-icon {
	margin-inline-end: 4px;
}
</style>

<!--
	Global (non-scoped): highlights the map marker matching the selected
	result-panel entry. The class itself is toggled by pumpCalculation.ts
	(applyEntryHighlight), not by this component — it must stay unscoped so
	the composable's DOM manipulation on the marker element can pick it up.
-->
<style>
.pump-result-selected-marker {
	/* No transform — MapLibre positions markers via transform. */
	filter: drop-shadow(0 0 3px var(--md-sys-primary)) drop-shadow(0 0 8px var(--md-sys-primary));
}
</style>
