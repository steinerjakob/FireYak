<script setup lang="ts">
import { IonButton, IonIcon, IonItem, IonLabel, IonList, IonNote, isPlatform } from '@ionic/vue';
import { close, navigate } from 'ionicons/icons';
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getMapNodeById } from '@/mapHandler/databaseHandler';
import { OverPassElement } from '@/mapHandler/overPassApi';

const emit = defineEmits<{
	(e: 'close'): void;
}>();

const props = defineProps<{ markerId: number }>();

const { t, te } = useI18n();
const markerData = ref<OverPassElement | null>(null);

// Map of tag keys to translation keys
const tagTranslationKeys: Record<string, string> = {
	emergency: 'markerInfo.tags.emergencyType',
	'fire_hydrant:type': 'markerInfo.tags.hydrantType',
	'fire_hydrant:diameter': 'markerInfo.tags.diameter',
	'fire_hydrant:pressure': 'markerInfo.tags.pressure',
	'fire_hydrant:flow_capacity': 'markerInfo.tags.flowCapacity',
	'fire_hydrant:position': 'markerInfo.tags.position',
	couplings: 'markerInfo.tags.couplings',
	'couplings:type': 'markerInfo.tags.couplingType',
	'couplings:diameters': 'markerInfo.tags.couplingDiameters',
	water_source: 'markerInfo.tags.waterSource',
	capacity: 'markerInfo.tags.capacity',
	volume: 'markerInfo.tags.volume',
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
	'couplings',
	'couplings:type',
	'couplings:diameters',
	'water_source',
	'capacity',
	'volume',
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
	// Check if this is a fire_hydrant field
	if (key.startsWith('fire_hydrant:')) {
		const translationKey = `markerInfo.values.${key}.${value}`;
		// Check if translation exists
		if (te(translationKey)) {
			return t(translationKey);
		}
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

const getTitle = () => {
	if (!markerData.value) return t('markerInfo.title.locationInfo');

	const emergency = markerData.value.tags?.emergency;
	const amenity = markerData.value.tags?.amenity;
	const name = markerData.value.tags?.name;

	if (name) return name;
	if (emergency === 'fire_hydrant') return t('markerInfo.title.fireHydrant');
	if (emergency === 'water_tank') return t('markerInfo.title.waterTank');
	if (emergency === 'suction_point') return t('markerInfo.title.suctionPoint');
	if (emergency === 'fire_water_pond') return t('markerInfo.title.fireWaterPond');
	if (amenity === 'fire_station') return t('markerInfo.title.fireStation');

	return t('markerInfo.title.locationInfo');
};

const openNavigation = () => {
	if (!markerData.value) return;

	const lat = markerData.value.lat || markerData.value.center?.lat;
	const lon = markerData.value.lon || markerData.value.center?.lon;

	if (lat && lon) {
		if (isPlatform('mobile')) {
			// Create a universal geo URL that works on both iOS and Android
			// iOS will open Apple Maps, Android will show options including Google Maps
			const geoUrl = `geo:${lat},${lon}?q=${lat},${lon}`;
			window.open(geoUrl, '_system');
		} else {
			const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
			window.open(googleMapsUrl, '_system');
		}
	}
};

onMounted(async () => {
	watch(
		() => props.markerId,
		async (newId) => {
			if (newId) {
				markerData.value = await getMapNodeById(props.markerId);
			}
		},
		{ immediate: true }
	);
});

const closeModal = () => {
	emit('close');
};
</script>

<template>
	<div class="marker-info-container">
		<div class="header">
			<h2 class="title">{{ getTitle() }}</h2>
			<ion-button fill="clear" @click="openNavigation" :title="t('markerInfo.navigation.title')">
				<ion-icon :icon="navigate" />
			</ion-button>
		</div>

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
			</ion-item>

			<!-- No data message -->
			<ion-item v-if="getFilteredTags().length === 0" lines="none">
				<ion-label>
					<ion-note>{{ t('markerInfo.messages.noAdditionalInfo') }}</ion-note>
				</ion-label>
			</ion-item>
		</ion-list>
		<ion-note v-else class="loading-note">{{ t('markerInfo.messages.loading') }}</ion-note>
	</div>
</template>

<style scoped>
.marker-info-container {
	flex-direction: column;
	height: 100%;
}

.header {
	position: sticky;
	top: 0;
	z-index: 10;
	background: var(--ion-background-color, #fff);
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 8px 12px;
	border-bottom: 1px solid var(--ion-color-light-shade);
}

.title {
	margin: 0;
	font-size: 1.25rem;
	font-weight: 600;
	color: var(--ion-color-dark);
}

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
	color: var(--ion-color-medium);
	margin-bottom: 2px;
}

ion-label p {
	font-size: 1rem;
	color: var(--ion-color-dark);
	margin-top: 0;
}

.loading-note {
	padding: 12px;
	display: block;
}
</style>
