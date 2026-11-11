<script setup lang="ts">
import { IonChip, IonItem, IonLabel, IonList } from '@ionic/vue';

import { useNearbyWaterSource } from '@/composable/nearbyWaterSource';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { useI18n } from 'vue-i18n';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import { coerceRef, toRef } from '@/helper/osmRef';
import { markerTitleKey } from '@/helper/markerTitle';
import { formatMeters, routeChips } from '@/helper/routeLabel';

const { list, updatedRefs, markInteraction } = useNearbyWaterSource();
const router = useRouter();
const route = useRoute();
const { t, locale } = useI18n();
const pumpCalculationStore = usePumpCalculationStore();

const getTitle = (markerData: OverPassElement) => {
	if (!markerData) return t('markerInfo.title.locationInfo');

	const name = markerData.tags?.name;
	if (name) return name;
	return t(markerTitleKey(markerData.tags));
};

const getBTubes = (distance: number) => {
	const tubes = t('pumpCalculation.pump.tubes');
	const neededBTubes = Math.ceil(distance / pumpCalculationStore.tubeLength);
	return `~${neededBTubes} ${pumpCalculationStore.hoseName}-${tubes}`;
};

const getDistanceText = (distance: number) => {
	// Metres like the map label (the same number for a routed line).
	const text = `${t('route.estimate', { distance: formatMeters(distance, locale.value) })} ${t('nearbyMarker.away')}`;
	return `${text} ${getBTubes(distance)}`;
};

const formattedList = computed(() => {
	return list.value.map((nearbyMarker) => {
		// Prefer the routed length: that is the length the hoses actually have
		// to cover (and what the B-tube count is for) and what the map label shows.
		const displayDistance = nearbyMarker.routedDistance ?? nearbyMarker.distance;
		return {
			ref: toRef(nearbyMarker.element.type, nearbyMarker.element.id),
			title: getTitle(nearbyMarker.element),
			icon: nearbyMarker.icon,
			distance: nearbyMarker.distance,
			distanceText: getDistanceText(displayDistance),
			chips: routeChips(nearbyMarker.route, nearbyMarker.fallback)
		};
	});
});

// Coerced, not compared raw: a legacy shared link still routes here as a bare
// number (`/nearbysources/123`), which would never match the `n123` refs the
// list items now carry.
const selectedMarkerRef = computed(() => {
	const param = Array.isArray(route.params.markerId)
		? route.params.markerId[0]
		: route.params.markerId;
	return param ? coerceRef(param) : null;
});
</script>

<template>
	<!-- Touch, scroll and wheel mark the list as in use: a silent recompute
	     then updates the metres but keeps the order until it is left alone. -->
	<ion-list
		class="info-list"
		@touchstart.passive="markInteraction"
		@pointerdown="markInteraction"
		@wheel.passive="markInteraction"
	>
		<!-- Nearby Water Sources -->
		<ion-item
			v-for="item in formattedList"
			:key="item.ref"
			button
			@click="router.push(`/nearbysources/${item.ref}`)"
			:class="{ selected: selectedMarkerRef === item.ref, updated: updatedRefs.has(item.ref) }"
		>
			<img slot="start" :src="item.icon" style="height: 24px" alt="Target marker" />
			<ion-label>
				<h3>{{ item.title }}</h3>
				<p>{{ item.distanceText }}</p>
				<div v-if="item.chips.length > 0" class="route-chips">
					<ion-chip
						v-for="chip in item.chips"
						:key="chip.key"
						:color="chip.color"
						:outline="chip.color === 'medium'"
					>
						{{ t(chip.key) }}
					</ion-chip>
				</div>
			</ion-label>
		</ion-item>
	</ion-list>
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

ion-icon {
	font-size: 20px;
	margin-right: 8px;
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

.route-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-top: 2px;
}

.route-chips ion-chip {
	margin: 0;
	height: 22px;
	font-size: 0.75rem;
	--padding-start: 8px;
	--padding-end: 8px;
}

.loading-note {
	padding: 12px;
	display: block;
}

/* Selected entry: highlight on every platform (items use <img>, not ion-icon,
   so tinting the icon alone would leave iOS without any visible highlight). */
ion-item.selected {
	--background: rgba(var(--ion-color-primary-rgb), 0.14);
	border-left: 3px solid var(--ion-color-primary);
}
/* A silent recompute changed this entry's metres (late map data). */
ion-item.updated {
	animation: route-updated 1.2s ease-out;
}
@keyframes route-updated {
	0%,
	40% {
		--background: rgba(var(--ion-color-warning-rgb), 0.28);
	}
	100% {
		--background: transparent;
	}
}
ion-item.selected h3 {
	color: var(--ion-color-primary);
}
</style>
