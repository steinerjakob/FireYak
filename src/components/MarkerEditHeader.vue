<script setup lang="ts">
import { IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon } from '@ionic/vue';
import { close, trashOutline } from 'ionicons/icons';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMarkerEditStore } from '@/store/markerEditStore';

const { t } = useI18n();
const markerEditStore = useMarkerEditStore();

const typeMap: Record<string, string> = {
	fire_hydrant: 'FireHydrant',
	suction_point: 'SuctionPoint',
	water_tank: 'WaterTank'
};

const titleKey = computed(() => {
	const type = markerEditStore.editableTags['emergency'] || 'fire_hydrant';
	const mode = markerEditStore.isAdding ? 'add' : 'edit';
	const suffix = typeMap[type] ?? 'FireHydrant';
	return `markerEdit.title.${mode}${suffix}`;
});

const closePanel = () => {
	markerEditStore.cancelEdit();
};
</script>

<template>
	<ion-header class="ion-no-border">
		<ion-toolbar>
			<ion-buttons slot="start">
				<ion-button
					v-if="markerEditStore.isEditing"
					@click="markerEditStore.requestDeleteMarker()"
					color="danger"
				>
					<ion-icon :icon="trashOutline" />
				</ion-button>
			</ion-buttons>

			<ion-title>
				{{ t(titleKey) }}
			</ion-title>

			<ion-buttons slot="end">
				<ion-button @click="closePanel">
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

	ion-toolbar {
		border-top-left-radius: var(--border-radius);

		border-top-right-radius: var(--border-radius);
	}

	.md {
		--border-radius: 28px;
	}
	.ios {
		--border-radius: 10px;
	}
}
</style>
