<script setup lang="ts">
/**
 * Add-mode helper for the fire-water-pond type (plan §B / §2.5 / §C / §D).
 *
 * Lists the OSM water areas at or next to the pin so the user can mark an
 * existing pond instead of adding a duplicate point. Pond areas that are
 * already flagged offer "edit" instead (duplicate guard); large or flowing
 * water suggests a suction point instead.
 */
import { IonButton, IonItem, IonLabel, IonNote, IonSpinner, IonIcon } from '@ionic/vue';
import { waterOutline, alertCircleOutline, cloudOfflineOutline } from 'ionicons/icons';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMarkerEditStore } from '@/store/markerEditStore';
import type { OverPassElement, WaterAreaCandidate } from '@/mapHandler/overPassApi';
import { toRef } from '@/helper/osmRef';

const emit = defineEmits<{ (e: 'switch-type', type: string): void }>();

const markerEditStore = useMarkerEditStore();
const { t, te, locale } = useI18n();

/** Above this (m²) a water area counts as large — same ~2 ha as the map check. */
const LARGE_WATER_M2 = 20_000;
/** `water=*` values that are flowing or lake-sized, never a typical fire pond. */
const LARGE_WATER_VALUES = ['lake', 'river', 'canal', 'stream', 'oxbow', 'lagoon'];

const state = computed(() => markerEditStore.areaLookupState);

const refOf = (e: OverPassElement) => toRef(e.type, e.id);

/**
 * Ponds that already exist near the pin (duplicate guard): fire-pond areas
 * from the search plus pond nodes/areas from the local marker cache, which
 * also works offline. Each is shown once, nearest first.
 */
const existingPonds = computed(() => {
	const seen = new Set<string>();
	const list: { element: OverPassElement; distanceM: number }[] = [];
	const add = (element: OverPassElement, distanceM: number) => {
		const ref = refOf(element);
		if (seen.has(ref)) return;
		seen.add(ref);
		list.push({ element, distanceM });
	};
	markerEditStore.areaCandidates
		.filter((c) => c.element.tags['emergency'] === 'fire_water_pond')
		.forEach((c) => add(c.element, c.inside ? 0 : c.distanceM));
	markerEditStore.nearbyPonds.forEach((p) => add(p.element, p.distanceM));
	return list.sort((a, b) => a.distanceM - b.distanceM);
});

/** Water areas without the flag — these can be marked as fire ponds. */
const candidates = computed(() =>
	markerEditStore.areaCandidates.filter((c) => c.element.tags['emergency'] == null)
);
const waterNearPin = computed(() => markerEditStore.detectedWater?.status === 'water');

function isLarge(c: WaterAreaCandidate): boolean {
	return (
		c.approxAreaM2 > LARGE_WATER_M2 || LARGE_WATER_VALUES.includes(c.element.tags['water'] ?? '')
	);
}

function title(element: OverPassElement): string {
	const tags = element.tags;
	if (tags['name']) return tags['name'];
	const waterKey = `markerInfo.values.water.${tags['water']}`;
	if (tags['water'] && te(waterKey)) return t(waterKey);
	return t('markerEdit.pondAreas.unnamed');
}

function formatArea(m2: number): string {
	const lang = locale.value || 'en';
	if (m2 >= 10_000) {
		return `${(m2 / 10_000).toLocaleString(lang, { maximumFractionDigits: 1 })} ha`;
	}
	// Round to a believable precision — this is a bounding-box estimate.
	const rounded = m2 >= 1000 ? Math.round(m2 / 100) * 100 : Math.max(10, Math.round(m2 / 10) * 10);
	return `${rounded.toLocaleString(lang)} m²`;
}

function existingSubtitle(p: { element: OverPassElement; distanceM: number }): string {
	const kind =
		p.element.type === 'node' ? t('markerEdit.pondAreas.point') : t('markerEdit.pondAreas.area');
	if (p.distanceM < 5) return `${kind} · ${t('markerEdit.pondAreas.atPin')}`;
	return `${kind} · ${t('markerEdit.pondAreas.metersAway', { m: Math.round(p.distanceM) })}`;
}

function subtitle(c: WaterAreaCandidate): string {
	const where = c.inside ? t('markerEdit.pondAreas.atPin') : t('markerEdit.pondAreas.nextToPin');
	return `${where} · ≈ ${formatArea(c.approxAreaM2)}`;
}
</script>

<template>
	<div class="pond-areas">
		<!-- Duplicate guard: ponds already mapped right here -->
		<template v-if="existingPonds.length">
			<ion-note class="intro">{{ t('markerEdit.pondAreas.existingIntro') }}</ion-note>
			<div v-for="p in existingPonds" :key="refOf(p.element)" class="candidate existing">
				<div class="candidate-text">
					<strong>{{ title(p.element) }}</strong>
					<span>{{ existingSubtitle(p) }}</span>
					<span class="badge">{{ t('markerEdit.pondAreas.alreadyPond') }}</span>
				</div>
				<div class="candidate-actions">
					<ion-button
						size="small"
						fill="outline"
						@click="markerEditStore.startEditing(p.element)"
						>{{ t('markerEdit.pondAreas.editExisting') }}</ion-button
					>
				</div>
			</div>
			<ion-note v-if="!(state === 'done' && candidates.length)" class="intro">{{
				t('markerEdit.pondAreas.orPoint')
			}}</ion-note>
		</template>

		<!-- Lookup running -->
		<ion-item v-if="state === 'loading'" lines="none">
			<ion-spinner slot="start" name="crescent" />
			<ion-label class="ion-text-wrap">{{ t('markerEdit.pondAreas.loading') }}</ion-label>
		</ion-item>

		<!-- Offline: only a point can be added -->
		<ion-item v-else-if="state === 'offline'" lines="none">
			<ion-icon slot="start" :icon="cloudOfflineOutline" />
			<ion-label class="ion-text-wrap">
				{{
					waterNearPin ? t('markerEdit.pondAreas.offlineWater') : t('markerEdit.pondAreas.offline')
				}}
			</ion-label>
		</ion-item>

		<ion-item v-else-if="state === 'failed'" lines="none">
			<ion-icon slot="start" :icon="alertCircleOutline" />
			<ion-label class="ion-text-wrap">{{ t('markerEdit.pondAreas.failed') }}</ion-label>
		</ion-item>

		<ion-item
			v-else-if="
				(state === 'skipped' || (state === 'done' && candidates.length === 0)) &&
				!existingPonds.length
			"
			lines="none"
		>
			<ion-icon slot="start" :icon="waterOutline" />
			<ion-label class="ion-text-wrap">{{ t('markerEdit.pondAreas.none') }}</ion-label>
		</ion-item>

		<!-- Candidates -->
		<template v-else-if="state === 'done' && candidates.length">
			<ion-note class="intro">{{ t('markerEdit.pondAreas.intro') }}</ion-note>
			<div v-for="c in candidates" :key="refOf(c.element)" class="candidate">
				<div class="candidate-text">
					<strong>{{ title(c.element) }}</strong>
					<span>{{ subtitle(c) }}</span>
					<span v-if="isLarge(c)" class="warning">{{ t('markerEdit.pondAreas.largeWater') }}</span>
				</div>
				<div class="candidate-actions">
					<ion-button size="small" @click="markerEditStore.startFlagging(c)">{{
						t('markerEdit.pondAreas.useArea')
					}}</ion-button>
					<ion-button
						v-if="isLarge(c)"
						size="small"
						fill="clear"
						@click="emit('switch-type', 'suction_point')"
						>{{ t('markerEdit.pondAreas.useSuctionPoint') }}</ion-button
					>
				</div>
			</div>
			<ion-note class="intro">{{ t('markerEdit.pondAreas.orPoint') }}</ion-note>
		</template>
	</div>
</template>

<style scoped>
.pond-areas {
	padding: 0 16px 8px;
}

.pond-areas ion-item {
	--padding-start: 0;
}

.intro {
	display: block;
	padding: 8px 0;
	font-size: 0.875rem;
	line-height: 1.4;
}

.candidate {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 12px;
	margin-bottom: 8px;
	border: 1px solid var(--md-sys-outline-variant, var(--ion-color-step-200));
	border-radius: 12px;
}

.candidate.existing {
	border-style: dashed;
}

.candidate-text {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.candidate-text span {
	font-size: 0.875rem;
	opacity: 0.8;
}

.candidate-text .badge,
.candidate-text .warning {
	opacity: 1;
	font-weight: 500;
}

.candidate-text .warning {
	color: var(--ion-color-warning-shade);
}

.candidate-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}
</style>
