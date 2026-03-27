<script setup lang="ts">
import { ref, watch } from 'vue';
import {
	IonModal,
	IonList,
	IonItem,
	IonLabel,
	IonRadioGroup,
	IonRadio,
	IonToggle,
	IonTitle
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
</script>

<template>
	<ion-modal
		:is-open="isOpen"
		@didDismiss="emit('update:isOpen', false)"
		class="layer-selector-modal"
	>
		<div class="layer-selector-wrapper">
			<ion-title class="layer-selector-title">{{ t('map.layers.title') }}</ion-title>
			<ion-list lines="none">
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
		</div>
	</ion-modal>
</template>

<style>
ion-modal.layer-selector-modal {
	--width: fit-content;
	--min-width: 250px;
	--height: fit-content;
	--border-radius: 16px;
	--box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}
</style>

<style scoped>
.layer-selector-wrapper {
	padding: 8px 0;
}

.layer-selector-title {
	margin: 8px 16px 4px;
	font-weight: 600;
}
</style>
