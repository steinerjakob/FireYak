<script setup lang="ts">
import { ref, watch } from 'vue';
import {
	IonModal,
	IonContent,
	IonList,
	IonItem,
	IonLabel,
	IonRadioGroup,
	IonRadio,
	IonToggle,
	IonToolbar,
	IonTitle,
	IonButtons,
	IonButton,
	IonHeader
} from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import { type MapLayerSetting, useSettingsStore } from '@/store/settingsStore';
import { storeToRefs } from 'pinia';
import { useSettings } from '@/composable/settings';

const props = defineProps<{
	isOpen: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:isOpen', value: boolean): void;
	(e: 'changed'): void;
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { mapLayer, terrain3d } = storeToRefs(settingsStore);
const { saveMapLayer, saveTerrain3d } = useSettings();

const selectedLayer = ref<MapLayerSetting>(mapLayer.value);
const terrainEnabled = ref(terrain3d.value);

watch(
	() => props.isOpen,
	(open) => {
		if (open) {
			selectedLayer.value = mapLayer.value;
			terrainEnabled.value = terrain3d.value;
		}
	}
);

async function onLayerChange(value: MapLayerSetting) {
	selectedLayer.value = value;
	await saveMapLayer(value);
	emit('changed');
}

async function onTerrainToggle(enabled: boolean) {
	terrainEnabled.value = enabled;
	await saveTerrain3d(enabled);
	emit('changed');
}

function close() {
	emit('update:isOpen', false);
}
</script>

<template>
	<ion-modal :is-open="isOpen" @didDismiss="close" :initial-breakpoint="1" :breakpoints="[0, 1]">
		<ion-header>
			<ion-toolbar>
				<ion-title>{{ t('map.layers.title') }}</ion-title>
				<ion-buttons slot="end">
					<ion-button @click="close">{{ t('map.layers.cancel') }}</ion-button>
				</ion-buttons>
			</ion-toolbar>
		</ion-header>
		<ion-content>
			<ion-list>
				<ion-radio-group :value="selectedLayer" @ionChange="onLayerChange($event.detail.value)">
					<ion-item>
						<ion-radio value="standard">{{ t('map.layers.standard') }}</ion-radio>
					</ion-item>
					<ion-item>
						<ion-radio value="satellite">{{ t('map.layers.satellite') }}</ion-radio>
					</ion-item>
				</ion-radio-group>
				<ion-item>
					<ion-toggle :checked="terrainEnabled" @ionChange="onTerrainToggle($event.detail.checked)">
						<ion-label>{{ t('map.layers.terrain3d') }}</ion-label>
					</ion-toggle>
				</ion-item>
			</ion-list>
		</ion-content>
	</ion-modal>
</template>
