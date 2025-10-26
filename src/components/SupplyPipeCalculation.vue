<script setup lang="ts">
import { computed, ref } from 'vue';
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
import { calculator, locateOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { usePumpCalculation } from '@/composable/pumpCalculation';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import wayPointIcon from '@/assets/markers/waypoint.png';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';

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
</script>

<template>
	<ion-list v-if="!pumpCalculation.calculationResult.value" class="info-list">
		<!-- Coordinates -->
		<ion-item>
			<img slot="start" :src="firepointIcon" style="height: 24px" alt="Fire point" />
			<ion-label>
				{{ t('pumpCalculation.fireObject') }}
			</ion-label>
			<ion-button
				slot="end"
				@click="pumpCalculation.setTargetPoint()"
				:color="pumpCalculation.firePointSet.value ? 'medium' : 'primary'"
			>
				<ion-icon :icon="locateOutline" slot="end"></ion-icon>
				<template v-if="pumpCalculation.firePointSet.value">
					{{ t('pumpCalculation.updatePosition') }}
				</template>
				<template v-else>
					{{ t('pumpCalculation.setPosition') }}
				</template>
			</ion-button>
		</ion-item>
		<ion-item>
			<img slot="start" :src="suctionPointIcon" style="height: 24px" alt="Suction point" />
			<ion-label>
				{{ t('pumpCalculation.suctionPoint') }}
			</ion-label>
			<ion-button
				slot="end"
				@click="pumpCalculation.setSuctionPoint()"
				:color="pumpCalculation.suctionPointSet.value ? 'medium' : 'primary'"
			>
				<ion-icon :icon="locateOutline" slot="end"></ion-icon>
				<template v-if="pumpCalculation.suctionPointSet.value">
					{{ t('pumpCalculation.updatePosition') }}
				</template>
				<template v-else>
					{{ t('pumpCalculation.setPosition') }}
				</template>
			</ion-button>
		</ion-item>
		<ion-item :disabled="!calculationAllowed">
			<img slot="start" :src="wayPointIcon" style="height: 24px" alt="Waypoint" />
			<ion-label>
				{{ t('pumpCalculation.wayPoint') }}
			</ion-label>
			<ion-button slot="end" @click="pumpCalculation.setWayPoint()" :disabled="!calculationAllowed">
				<ion-icon :icon="locateOutline" slot="end"></ion-icon>
				{{ t('pumpCalculation.setPosition') }}
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
	color: var(--ion-color-dark);
}

.result-value {
	color: var(--ion-color-dark);
	text-align: right;
}
</style>
