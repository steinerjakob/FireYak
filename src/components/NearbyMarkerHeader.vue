<script setup lang="ts">
import { IonButton, IonIcon, IonHeader, IonToolbar, IonTitle, IonButtons } from '@ionic/vue';
import { close } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import router from '@/router';

const { t } = useI18n();

const closePanel = () => {
	router.push('/');
};
</script>

<template>
	<ion-header class="ion-no-border">
		<ion-toolbar>
			<ion-title>{{ t('nearbyMarker.title') }}</ion-title>
			<ion-buttons slot="end">
				<ion-button @click="closePanel" :title="t('pumpCalculation.buttons.close')">
					<ion-icon :icon="close" />
				</ion-button>
			</ion-buttons>
		</ion-toolbar>
	</ion-header>
</template>

<style scoped>
ion-header {
	border-bottom: 1px solid var(--ion-color-light-shade);
	--ion-safe-area-top: 0;
	--ion-safe-area-bottom: 0;
	--ion-safe-area-left: 0;
	--ion-safe-area-right: 0;
}
</style>
