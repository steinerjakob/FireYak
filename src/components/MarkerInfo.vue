<script setup lang="ts">
import {
	IonButton,
	IonCard,
	IonCardContent,
	IonCardHeader,
	IonCardTitle,
	IonIcon,
	IonItem,
	IonLabel,
	IonList,
	IonNote,
	isPlatform
} from '@ionic/vue';
import { close, navigate } from 'ionicons/icons';
import { onMounted, ref, watch } from 'vue';
import { getMapNodeById } from '@/mapHandler/databaseHandler';
import { OverPassElement } from '@/mapHandler/overPassApi';

const emit = defineEmits<{
	(e: 'close'): void;
}>();

const props = defineProps<{ markerId: number }>();

const markerData = ref<OverPassElement | null>(null);

// Map of tag keys to human-readable labels
const tagLabels: Record<string, string> = {
	emergency: 'Emergency Type',
	'fire_hydrant:type': 'Hydrant Type',
	'fire_hydrant:diameter': 'Diameter',
	'fire_hydrant:pressure': 'Pressure',
	'fire_hydrant:position': 'Position',
	couplings: 'Couplings',
	'couplings:type': 'Coupling Type',
	'couplings:diameters': 'Coupling Diameters',
	water_source: 'Water Source',
	capacity: 'Capacity',
	volume: 'Volume',
	ref: 'Reference Number',
	operator: 'Operator',
	name: 'Name',
	amenity: 'Amenity',
	'addr:street': 'Street',
	'addr:housenumber': 'House Number',
	'addr:city': 'City',
	'addr:postcode': 'Postcode',
	description: 'Description',
	note: 'Note',
	'survey:date': 'Survey Date',
	access: 'Access',
	location: 'Location'
};

// Tags that are relevant for fire brigades
const relevantTags = [
	//'emergency',
	'fire_hydrant:type',
	'fire_hydrant:diameter',
	'fire_hydrant:pressure',
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

const getFilteredTags = () => {
	if (!markerData.value?.tags) return [];

	return Object.entries(markerData.value.tags)
		.filter(([key]) => relevantTags.includes(key))
		.map(([key, value]) => ({
			key,
			label: tagLabels[key] || key,
			value
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
	if (!markerData.value) return 'Location Info';

	const emergency = markerData.value.tags?.emergency;
	const amenity = markerData.value.tags?.amenity;
	const name = markerData.value.tags?.name;

	if (name) return name;
	if (emergency === 'fire_hydrant') return 'Fire Hydrant';
	if (emergency === 'water_tank') return 'Water Tank';
	if (emergency === 'suction_point') return 'Suction Point';
	if (emergency === 'fire_water_pond') return 'Fire Water Pond';
	if (amenity === 'fire_station') return 'Fire Station';

	return 'Location Info';
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
	<ion-card>
		<ion-card-header>
			<div class="header-content">
				<ion-card-title>{{ getTitle() }}</ion-card-title>
				<ion-button fill="clear" @click="openNavigation" title="Navigate to location">
					<ion-icon :icon="navigate" />
				</ion-button>
			</div>
		</ion-card-header>
		<ion-card-content>
			<ion-list v-if="markerData">
				<!-- Relevant Tags -->
				<ion-item v-for="tag in getFilteredTags()" :key="tag.key">
					<ion-label>
						<h3>{{ tag.label }}</h3>
						<p>{{ tag.value }}</p>
					</ion-label>
				</ion-item>
				<!-- Coordinates -->
				<ion-item v-if="getCoordinates()">
					<ion-label>
						<h3>Coordinates</h3>
						<p>{{ getCoordinates() }}</p>
					</ion-label>
				</ion-item>

				<!-- OSM ID -->
				<ion-item>
					<ion-label>
						<h3>OSM ID</h3>
						<p>{{ markerData.id }} ({{ markerData.type }})</p>
					</ion-label>
				</ion-item>

				<!-- No data message -->
				<ion-item v-if="getFilteredTags().length === 0">
					<ion-label>
						<ion-note>No additional information available</ion-note>
					</ion-label>
				</ion-item>
			</ion-list>
			<ion-note v-else>Loading marker information...</ion-note>
		</ion-card-content>
	</ion-card>
</template>

<style scoped>
.header-content {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px;
}

ion-list {
	background: transparent;
}

ion-item {
	--background: transparent;
}

ion-label h3 {
	font-weight: 600;
	font-size: 0.875rem;
	color: var(--ion-color-medium);
	margin-bottom: 4px;
}

ion-label p {
	font-size: 1rem;
	color: var(--ion-color-dark);
}
</style>
