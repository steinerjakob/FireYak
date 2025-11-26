<script setup lang="ts">
import { IonButton, IonIcon, IonItem, IonLabel, IonList, IonNote } from '@ionic/vue';
import { openOutline, createOutline } from 'ionicons/icons';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMapMarkerStore } from '@/store/mapMarkerStore';

const markerStore = useMapMarkerStore();

const { t, te } = useI18n();
const markerData = computed(() => markerStore.selectedMarker);

const waterTankVolume = 'markerInfo.tags.volume';

// Map of tag keys to translation keys
const tagTranslationKeys: Record<string, string> = {
	emergency: 'markerInfo.tags.emergencyType',
	'fire_hydrant:type': 'markerInfo.tags.hydrantType',
	'fire_hydrant:diameter': 'markerInfo.tags.diameter',
	'fire_hydrant:pressure': 'markerInfo.tags.pressure',
	'fire_hydrant:flow_capacity': 'markerInfo.tags.flowCapacity',
	flow_rate: 'markerInfo.tags.flowRate',
	'fire_hydrant:position': 'markerInfo.tags.position',
	couplings: 'markerInfo.tags.couplings',
	'couplings:type': 'markerInfo.tags.couplingType',
	'couplings:diameters': 'markerInfo.tags.couplingDiameters',
	water_source: 'markerInfo.tags.waterSource',
	capacity: 'markerInfo.tags.capacity',
	volume: waterTankVolume,
	'water_tank:volume': waterTankVolume,
	water_volume: waterTankVolume,
	ref: 'markerInfo.tags.referenceNumber',
	operator: 'markerInfo.tags.operator',
	name: 'markerInfo.tags.name',
	amenity: 'markerInfo.tags.amenity',
	'addr:street': 'markerInfo.tags.street',
	'addr:housenumber': 'markerInfo.tags.houseNumber',
	'addr:city': 'markerInfo.tags.city',
	'addr:postcode': 'markerInfo.tags.postcode',
	description: 'markerInfo.tags.description',
	note: 'markerInfo.tags.note',
	'survey:date': 'markerInfo.tags.surveyDate',
	access: 'markerInfo.tags.access',
	location: 'markerInfo.tags.location'
};

// Tags that are relevant for fire brigades
const relevantTags = [
	//'emergency',
	'fire_hydrant:type',
	'fire_hydrant:diameter',
	'fire_hydrant:pressure',
	'fire_hydrant:flow_capacity',
	'fire_hydrant:position',
	'flow_rate',
	'couplings',
	'couplings:type',
	'couplings:diameters',
	'water_source',
	'capacity',
	'volume',
	'water_tank:volume',
	'water_volume',
	'ref',
	'operator',
	'name',
	'amenity',
	'addr:street',
	'addr:housenumber',
	'addr:city',
	'addr:postcode',
	'description',
	'note',
	'survey:date',
	'access',
	'location'
];

// Translate value if translation exists
const translateValue = (key: string, value: string): string => {
	// Check if this is a fire_hydrant field or water_source
	if (key.startsWith('fire_hydrant:') || key === 'water_source') {
		const translationKey = `markerInfo.values.${key}.${value}`;
		// Check if translation exists
		if (te(translationKey)) {
			return t(translationKey);
		}
	}

	// Add unit for flow rate
	if (['capacity', 'volume', 'water_tank:volume', 'water_volume'].includes(key)) {
		return `${value} l`;
	}

	// Return original value if no translation found
	return value;
};

const getFilteredTags = () => {
	if (!markerData.value?.tags) return [];

	return Object.entries(markerData.value.tags)
		.filter(([key]) => relevantTags.includes(key))
		.map(([key, value]) => ({
			key,
			label: t(tagTranslationKeys[key] || key),
			value: translateValue(key, value)
		}))
		.sort((a, b) => {
			const aIndex = relevantTags.indexOf(a.key);
			const bIndex = relevantTags.indexOf(b.key);
			return aIndex - bIndex;
		});
};

const getCoordinates = () => {
	if (!markerData.value) return null;
	const lat = markerData.value.lat || markerData.value.center?.lat;
	const lon = markerData.value.lon || markerData.value.center?.lon;
	if (lat && lon) {
		return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
	}
	return null;
};

const openOsmUrl = () => {
	if (!markerData.value) return '';
	window.open(
		`https://www.openstreetmap.org/${markerData.value.type}/${markerData.value.id}`,
		'_blank'
	);
};

const openOsmEditUrl = () => {
	if (!markerData.value) return '';
	window.open(
		`https://www.openstreetmap.org/edit?${markerData.value.type}=${markerData.value.id}`,
		'_blank'
	);
};
</script>

<template>
	<ion-list v-if="markerData" class="info-list">
		<!-- Relevant Tags -->
		<ion-item v-for="tag in getFilteredTags()" :key="tag.key" lines="none">
			<ion-label>
				<h3>{{ tag.label }}</h3>
				<p>{{ tag.value }}</p>
			</ion-label>
		</ion-item>

		<!-- Coordinates -->
		<ion-item v-if="getCoordinates()" lines="none">
			<ion-label>
				<h3>{{ t('markerInfo.tags.coordinates') }}</h3>
				<p>{{ getCoordinates() }}</p>
			</ion-label>
		</ion-item>

		<!-- OSM ID -->
		<ion-item lines="none">
			<ion-label>
				<h3>{{ t('markerInfo.tags.osmId') }}</h3>
				<p>{{ markerData.id }} ({{ markerData.type }})</p>
			</ion-label>
			<div slot="end">
				<ion-button fill="clear" @click="openOsmEditUrl">
					<ion-icon :icon="createOutline" />
				</ion-button>
				<ion-button fill="clear" @click="openOsmUrl">
					<ion-icon :icon="openOutline" />
				</ion-button>
			</div>
		</ion-item>

		<!-- No data message -->
		<ion-item v-if="getFilteredTags().length === 0" lines="none">
			<ion-label>
				<ion-note>{{ t('markerInfo.messages.noAdditionalInfo') }}</ion-note>
			</ion-label>
		</ion-item>
	</ion-list>
	<ion-note v-else class="loading-note">{{ t('markerInfo.messages.loading') }}</ion-note>
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
	margin-bottom: 2px;
}

ion-label p {
	font-size: 1rem !important;
	margin-top: 0;
}

.loading-note {
	padding: 12px;
	display: block;
}
</style>
