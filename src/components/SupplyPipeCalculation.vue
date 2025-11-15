<script setup lang="ts">
import { computed } from 'vue';
import {
	IonButton,
	IonIcon,
	IonInput,
	IonItem,
	IonLabel,
	IonList,
	IonSelect,
	IonSelectOption
} from '@ionic/vue';
import { calculator, locate } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { usePumpCalculation } from '@/composable/pumpCalculation';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import wayPointIcon from '@/assets/markers/waypoint.png';
import pumpIcon from '@/assets/markers/markerpump.png'; // Add pump icon import
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import { PumpPosition } from '@/helper/calculatePumpPosition';

const { t } = useI18n();
const pumpCalculation = usePumpCalculation();
const pumpCalculationStore = usePumpCalculationStore();

const calculationAllowed = computed(() => {
	return pumpCalculation.firePointSet.value && pumpCalculation.suctionPointSet.value;
});

const flowRateChanged = (event: CustomEvent) => {
	const value = event.detail.value;
	console.log(value);
	pumpCalculationStore.pressureLost = Number(value);
};

const inputPressureChanged = (event: CustomEvent) => {
	const value = event.detail.value;
	pumpCalculationStore.inputPressure = Number(value);
};

const outputPressureChanged = (event: CustomEvent) => {
	const value = event.detail.value;
	pumpCalculationStore.outputPressure = Number(value);
};

const tubeCount = computed(() => {
	return (
		(pumpCalculation.calculationResult.value?.realDistance || 0) / pumpCalculationStore.tubeLength
	).toFixed(0);
});

const selectPumpMarker = (pumpPosition: PumpPosition) => {
	pumpPosition.marker.openPopup();
};

const selectTargetMarker = () => {
	if (pumpCalculation.calculationResult.value?.targetPoint) {
		pumpCalculation.calculationResult.value?.targetPoint.openPopup();
	}
};
const selectSuctionPoint = () => {
	if (pumpCalculation.calculationResult.value?.suctionPoint) {
		pumpCalculation.calculationResult.value?.suctionPoint.openPopup();
	}
};

const pumpPositions = computed(() => {
	return (pumpCalculation.calculationResult.value?.pumpPositions || []).toReversed();
});

const pumpPositionInfo = (pump: PumpPosition) => {
	const inpuPressure = t('pumpCalculation.pump.inputPressure');
	const tubes = t('pumpCalculation.pump.tubes');
	return `B-${tubes}: ~${pump.neededBTubes}; ${inpuPressure}: ${pump.pressureAtTrigger.toFixed(2)}`;
};

const targetMarkerInfo = () => {
	const pumpCalculationResult = pumpCalculation.calculationResult.value;
	if (!pumpCalculationResult) {
		return;
	}

	const lastPump =
		pumpCalculationResult.pumpPositions[pumpCalculationResult.pumpPositions.length - 1];
	const prevDistance = lastPump?.distanceFromStart || 0;

	const distance = pumpCalculationResult.realDistance - prevDistance;

	const neededBTubes = Math.round(distance / pumpCalculationStore.tubeLength);
	const lastElevation =
		pumpCalculationResult.elevationData[pumpCalculationResult.elevationData.length - 1];
	const pressure = lastElevation.pressure || 0;

	const inpuPressure = t('pumpCalculation.pump.inputPressure');
	const tubes = t('pumpCalculation.pump.tubes');
	return `B-${tubes}: ~${neededBTubes}; ${inpuPressure}: ${pressure.toFixed(2)}`;
};
</script>

<template>
	<ion-list v-if="!pumpCalculation.calculationResult.value" class="info-list">
		<!-- Coordinates -->
		<ion-item button @click="pumpCalculation.setTargetPoint()">
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
		<ion-item button @click="pumpCalculation.setSuctionPoint()">
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
		<ion-item button @click="pumpCalculation.setWayPoint()" :disabled="!calculationAllowed">
			<img slot="start" :src="wayPointIcon" style="height: 24px" alt="Waypoint" />
			<ion-label>
				{{ t('pumpCalculation.wayPoint') }}
			</ion-label>
			<ion-button slot="end" @click="pumpCalculation.setWayPoint()" :disabled="!calculationAllowed">
				{{ t('pumpCalculation.setPosition') }}
				<ion-icon :icon="locate" slot="end"></ion-icon>
			</ion-button>
		</ion-item>
		<ion-item>
			<ion-select
				:label="t('pumpCalculation.pump.flowRate')"
				placeholder="Make a Selection"
				:value="pumpCalculationStore.pressureLost.toString()"
				@ionChange="flowRateChanged"
			>
				<ion-select-option value="0.1">200 l/min</ion-select-option>
				<ion-select-option value="0.2">400 l/min</ion-select-option>
				<ion-select-option value="0.7">600 l/min</ion-select-option>
				<ion-select-option value="1.1">800 l/min</ion-select-option>
				<ion-select-option value="1.7">1000 l/min</ion-select-option>
				<ion-select-option value="2.5">1200 l/min</ion-select-option>
				<ion-select-option value="4.5">1600l/min</ion-select-option>
			</ion-select>
		</ion-item>
		<ion-item>
			<ion-input
				:label="t('pumpCalculation.pump.inputPressure')"
				type="number"
				:value="pumpCalculationStore.inputPressure"
				@ionChange="inputPressureChanged"
			></ion-input>
		</ion-item>
		<ion-item>
			<ion-input
				:label="t('pumpCalculation.pump.outputPressure')"
				type="number"
				:value="pumpCalculationStore.outputPressure"
				@ionChange="outputPressureChanged"
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
		<ion-item>
			<ion-label>
				<div class="calculation-results">
					<div class="result-row">
						<span class="result-label">B-{{ t('pumpCalculation.pump.tubes') }}:</span>
						<span class="result-value">~{{ tubeCount }}</span>
					</div>
					<div class="result-row">
						<span class="result-label">{{ t('pumpCalculation.pump.title') }}:</span>
						<span class="result-value"
							>~{{ pumpCalculation.calculationResult.value.pumpCount }}</span
						>
					</div>
					<div class="result-row">
						<span class="result-label">{{ t('pumpCalculation.pump.distanceFromStart') }}:</span>
						<span class="result-value"
							>~{{ pumpCalculation.calculationResult.value.realDistance.toFixed(0) }}m</span
						>
					</div>
					<div class="result-row">
						<span class="result-label">{{ t('pumpCalculation.pump.elevationDifference') }}:</span>
						<span class="result-value"
							>~{{ pumpCalculation.calculationResult.value.elevation }}m</span
						>
					</div>
				</div>
			</ion-label>
		</ion-item>

		<!-- Marker navigation items todo center based on router -->
		<ion-item button @click="selectTargetMarker()">
			<img slot="start" :src="firepointIcon" style="height: 24px" alt="Target marker" />
			<ion-label>
				<h3>{{ t('pumpCalculation.fireObject') }}</h3>
				<p>{{ targetMarkerInfo() }}</p>
			</ion-label>
		</ion-item>

		<template v-for="position of pumpPositions" :key="position.distanceFromStart">
			<ion-item button @click="selectPumpMarker(position as PumpPosition)">
				<img slot="start" :src="pumpIcon" style="height: 24px" alt="Pump marker" />
				<ion-label>
					<h3>{{ t('pumpCalculation.pump.title') }}</h3>
					<p>{{ pumpPositionInfo(position as PumpPosition) }}</p>
				</ion-label>
			</ion-item>
		</template>

		<ion-item button @click="selectSuctionPoint()">
			<img slot="start" :src="suctionPointIcon" style="height: 24px" alt="Suction marker" />
			<ion-label>
				<h3>{{ t('pumpCalculation.suctionPoint') }}</h3>
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


.calculation-results {
	width: 100%;
}

.result-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 8px;
}

.result-row:last-child {
	margin-bottom: 0;
}

.result-label {
	font-weight: bold;
}

.result-value {
	text-align: right;
}
</style>
