<script setup lang="ts">
import { IonItem, IonLabel, IonList, IonIcon } from '@ionic/vue';
import { locateOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { usePumpCalculation } from '@/composable/pumpCalculation';

const { t } = useI18n();
const pumpCalculation = usePumpCalculation();
</script>

<template>
	<ion-list class="info-list">
		<!-- Coordinates -->
		<ion-item>
			<ion-label>
				{{ t('pumpCalculation.fireObject') }}
			</ion-label>
			<ion-button slot="end" @click="pumpCalculation.setTargetPoint()">
				<ion-icon :icon="locateOutline" slot="end"></ion-icon>
				{{ t('pumpCalculation.setPosition') }}
			</ion-button>
		</ion-item>
		<ion-item>
			<ion-label>
				{{ t('pumpCalculation.suctionPoint') }}
			</ion-label>
			<ion-button slot="end" @click="pumpCalculation.setSuctionPoint()">
				<ion-icon :icon="locateOutline" slot="end"></ion-icon>
				{{ t('pumpCalculation.setPosition') }}
			</ion-button>
		</ion-item>
		<ion-item>
			<ion-label>
				{{ t('pumpCalculation.wayPoint') }}
			</ion-label>
			<ion-button slot="end" @click="pumpCalculation.setWayPoint()">
				<ion-icon :icon="locateOutline" slot="end"></ion-icon>
				{{ t('pumpCalculation.setPosition') }}
			</ion-button>
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
