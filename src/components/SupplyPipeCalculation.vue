<script setup lang="ts">
import { computed } from 'vue';
import { IonItem, IonLabel, IonList, IonIcon, IonButton } from '@ionic/vue';
import { locateOutline, calculator } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { usePumpCalculation } from '@/composable/pumpCalculation';

const { t } = useI18n();
const pumpCalculation = usePumpCalculation();

const calculationAllowed = computed(() => {
	return pumpCalculation.firePointSet.value && pumpCalculation.suctionPointSet.value;
});
</script>

<template>
	<ion-list class="info-list">
		<!-- Coordinates -->
		<ion-item>
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
			<ion-label>
				{{ t('pumpCalculation.wayPoint') }}
			</ion-label>
			<ion-button slot="end" @click="pumpCalculation.setWayPoint()" :disabled="!calculationAllowed">
				<ion-icon :icon="locateOutline" slot="end"></ion-icon>
				{{ t('pumpCalculation.setPosition') }}
			</ion-button>
		</ion-item>
		<ion-button
			expand="block"
			class="ion-margin-top ion-margin-horizontal"
			:disabled="!calculationAllowed"
		>
			<ion-icon :icon="calculator" slot="start"></ion-icon>
			{{ t('pumpCalculation.buttons.calculate') }}
		</ion-button>
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

ion-label h3 {
	font-weight: 600;
	font-size: 0.875rem;
	color: var(--ion-color-medium);
	margin-bottom: 2px;
}

ion-label p {
	font-size: 1rem;
	color: var(--ion-color-dark);
	margin-top: 0;
}

.loading-note {
	padding: 12px;
	display: block;
}
</style>
