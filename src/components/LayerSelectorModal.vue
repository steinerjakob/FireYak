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
import { type MapLayerSetting, type MarkerFilters, useSettingsStore } from '@/store/settingsStore';
import { storeToRefs } from 'pinia';
import { useSettings } from '@/composable/settings';
import { markerIconUrls } from '@/mapHandler/markerHandler';

const props = defineProps<{
	isOpen: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:isOpen', value: boolean): void;
	(e: 'changed'): void;
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { mapLayer, terrain3d, markerFilters } = storeToRefs(settingsStore);
const { saveMapLayer, saveTerrain3d, saveMarkerFilters } = useSettings();

const selectedLayer = ref<MapLayerSetting>(mapLayer.value);
const terrainEnabled = ref(terrain3d.value);
const localFilters = ref<MarkerFilters>({ ...markerFilters.value });

watch(
	() => props.isOpen,
	(open) => {
		if (open) {
			selectedLayer.value = mapLayer.value;
			terrainEnabled.value = terrain3d.value;
			localFilters.value = { ...markerFilters.value };
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

async function onFilterToggle(key: keyof MarkerFilters, enabled: boolean) {
	localFilters.value = { ...localFilters.value, [key]: enabled };
	await saveMarkerFilters({ ...localFilters.value });
	emit('changed');
}

/** Categories in display order with their representative icon key. */
const filterCategories: Array<{ key: keyof MarkerFilters; icon: string; labelKey: string }> = [
	{ key: 'fireHydrant', icon: 'hydrant', labelKey: 'map.filters.fireHydrant' },
	{ key: 'suctionPoint', icon: 'pump', labelKey: 'map.filters.suctionPoint' },
	{ key: 'waterTank', icon: 'watertank', labelKey: 'map.filters.waterTank' },
	{ key: 'fireWaterPond', icon: 'water', labelKey: 'map.filters.fireWaterPond' },
	{ key: 'fireStation', icon: 'firestation', labelKey: 'map.filters.fireStation' }
];

/** Hydrant subtypes shown as a compact legend below the hydrant filter row. */
const hydrantSubtypes: Array<{ icon: string; labelKey: string }> = [
	{ icon: 'hydrant', labelKey: 'map.legend.pillarHydrant' },
	{ icon: 'underground', labelKey: 'map.legend.undergroundHydrant' },
	{ icon: 'wall', labelKey: 'map.legend.wallHydrant' }
];
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

			<ion-title class="layer-selector-title section-title">{{ t('map.filters.title') }}</ion-title>
			<ion-list lines="none">
				<template v-for="cat in filterCategories" :key="cat.key">
					<ion-item>
						<ion-toggle
							:checked="localFilters[cat.key]"
							@ionChange="onFilterToggle(cat.key, $event.detail.checked)"
						>
							<div class="filter-label">
								<img :src="markerIconUrls[cat.icon]" class="filter-icon" :alt="t(cat.labelKey)" />
								<ion-label>{{ t(cat.labelKey) }}</ion-label>
							</div>
						</ion-toggle>
					</ion-item>
					<!-- Hydrant subtypes legend, shown directly below the hydrant row -->
					<div v-if="cat.key === 'fireHydrant'" class="subtype-legend">
						<span class="subtype-legend-title">{{ t('map.legend.title') }}</span>
						<div v-for="sub in hydrantSubtypes" :key="sub.icon" class="subtype-row">
							<img :src="markerIconUrls[sub.icon]" class="subtype-icon" :alt="t(sub.labelKey)" />
							<span class="subtype-label">{{ t(sub.labelKey) }}</span>
						</div>
					</div>
				</template>
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

.section-title {
	margin-top: 12px;
}

.filter-label {
	display: flex;
	align-items: center;
	gap: 10px;
}

.filter-icon {
	width: 28px;
	height: 28px;
	object-fit: contain;
	flex-shrink: 0;
}

.subtype-legend {
	padding: 4px 16px 8px 32px;
}

.subtype-legend-title {
	display: block;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--md-sys-on-surface-variant);
	margin-bottom: 4px;
}

.subtype-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 2px 0;
}

.subtype-icon {
	width: 22px;
	height: 22px;
	object-fit: contain;
	flex-shrink: 0;
}

.subtype-label {
	font-size: 13px;
	color: var(--md-sys-on-surface-variant);
}
</style>
