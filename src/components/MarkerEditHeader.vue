<script setup lang="ts">
import { IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon } from '@ionic/vue';
import { closeOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { useMarkerEditStore } from '@/store/markerEditStore';

const { t } = useI18n();
const markerEditStore = useMarkerEditStore();

const close = () => {
	markerEditStore.cancelEdit();
};
</script>

<template>
	<ion-header class="ion-no-border">
		<ion-toolbar>
			<ion-buttons slot="start">
				<ion-button @click="close">
					<ion-icon :icon="closeOutline" />
				</ion-button>
			</ion-buttons>

			<ion-title>
				{{
					markerEditStore.isAdding
						? t('markerEdit.title.add')
						: t('markerEdit.title.edit')
				}}
			</ion-title>
		</ion-toolbar>
	</ion-header>
</template>

<style scoped>
ion-toolbar {
	--background: transparent;
	--border-width: 0;
}

ion-title {
	font-weight: 700;
	font-size: 1.25rem;
}
</style>
