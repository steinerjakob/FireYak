<script setup lang="ts">
import { IonButton, IonIcon, IonHeader, IonToolbar, IonTitle, IonButtons } from '@ionic/vue';
import { close } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import router from '@/router';

const { t } = useI18n();

const getTitle = () => {
	return t('pumpCalculation.title');
};

const closeSupplyPipe = () => {
	router.push('/');
};
</script>

<template>
	<ion-header class="ion-no-border">
		<ion-toolbar>
			<ion-title>{{ getTitle() }}</ion-title>
			<ion-buttons slot="end">
				<ion-button @click="closeSupplyPipe" :title="t('pumpCalculation.buttons.close')">
					<ion-icon :icon="close" />
				</ion-button>
			</ion-buttons>
		</ion-toolbar>
	</ion-header>
</template>

<style scoped>
ion-header {
	border-bottom: 1px solid var(--ion-color-light-shade);
}
</style>
