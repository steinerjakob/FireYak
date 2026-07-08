<script setup lang="ts">
import { ref, watch } from 'vue';
import {
	IonPopover,
	IonList,
	IonItem,
	IonLabel,
	IonRadioGroup,
	IonRadio,
	IonToggle
} from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import { type MapLayerSetting, type MarkerFilters, useSettingsStore } from '@/store/settingsStore';
import { storeToRefs } from 'pinia';
import { useSettings } from '@/composable/settings';
import { markerIconUrls } from '@/mapHandler/markerHandler';

const props = defineProps<{
	isOpen: boolean;
	event?: Event;
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
	<!-- Anchored dropdown, not a centered dialog: this is a quick layer/filter
	     menu next to the FAB that triggered it, matching MD3 menu conventions
	     and picking up the ios26 theme's native popover glass automatically -->
	<ion-popover
		:is-open="isOpen"
		:event="event"
		side="bottom"
		alignment="start"
		:dismiss-on-select="false"
		@didDismiss="emit('update:isOpen', false)"
		class="layer-selector-popover"
	>
		<div class="layer-selector-wrapper">
			<!-- Plain headings: ion-title is absolutely positioned in ios mode and
			     collapses to nothing outside a toolbar -->
			<div class="layer-selector-title">{{ t('map.layers.title') }}</div>
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

			<div class="layer-selector-title section-title">{{ t('map.filters.title') }}</div>
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
	</ion-popover>
</template>

<style>
ion-popover.layer-selector-popover {
	--width: min(300px, 92vw);
	--max-height: min(560px, 80vh);
	--box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}

/* ion-item/ion-list paint their own opaque background by default, which
   sits on top of the popover's surface (glass in ios, surface-container in
   md) and breaks it into a checkerboard of solid rows. Let the popover's
   own background show through everywhere instead — this is the same
   transparent-item treatment the ios26 theme applies to ion-select-popover,
   just extended to our custom list content. */
ion-popover.layer-selector-popover ion-list,
ion-popover.layer-selector-popover ion-item {
	--background: transparent;
	--ion-item-background: transparent;
}

/* MD3 menu spec: surface-container elevation, small corner radius.
   (src/theme/md3/ionic/popover.css sets --background/--color/--box-shadow
   for ion-popover generally.) Ionic's md popover hardcodes .popover-content
   border-radius rather than reading a CSS var, so target the shadow part. */
:root[mode='md'] ion-popover.layer-selector-popover::part(content) {
	border-radius: 12px;
}
</style>

<style scoped>
.layer-selector-wrapper {
	padding: 8px 0;
}

.layer-selector-title {
	margin: 8px 16px 4px;
	padding: 0 4px;
	font-size: 16px;
	font-weight: 600;
	line-height: 24px;
	color: var(--md-sys-on-surface);
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
