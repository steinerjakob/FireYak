<script setup lang="ts">
import { IonButton, IonIcon, IonHeader, IonToolbar, IonTitle, IonButtons } from '@ionic/vue';
import { close, arrowBack } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import router from '@/router';
import { usePumpCalculation } from '@/composable/pumpCalculation';
const pumpCalculation = usePumpCalculation();

const { t } = useI18n();

const getTitle = () => {
	return t('pumpCalculation.title');
};

const closeSupplyPipe = () => {
	router.replace('/');
	pumpCalculation.calculationResult.value = null;
};
</script>

<template>
	<!-- ios26-disabled: keep a plain sheet toolbar; the iOS 26 floating
	     button pills are page-header chrome and look broken inside sheets -->
	<ion-header class="ion-no-border ios26-disabled">
		<ion-toolbar class="ios26-disabled">
			<ion-buttons slot="start">
				<ion-button
					v-show="pumpCalculation.calculationResult.value"
					@click="pumpCalculation.calculationResult.value = null"
					:title="t('pumpCalculation.buttons.reset')"
				>
					<ion-icon :icon="arrowBack" />
				</ion-button>
			</ion-buttons>

			<ion-title>{{ getTitle() }}</ion-title>
			<ion-buttons slot="start">
				<ion-button @click="closeSupplyPipe" :title="t('pumpCalculation.buttons.close')">
					<ion-icon :icon="close" />
				</ion-button>
			</ion-buttons>
		</ion-toolbar>
	</ion-header>
</template>

<style scoped>
ion-header {
	border-bottom: 1px solid var(--md-sys-outline-variant);
	--ion-safe-area-top: 0;
	--ion-safe-area-bottom: 0;
	--ion-safe-area-left: 0;
	--ion-safe-area-right: 0;
}
</style>
