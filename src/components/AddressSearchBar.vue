<template>
	<div class="search-container">
		<div
			class="search-bar-row"
			:class="{ 'has-attached-panel': hasAttachedPanel, mobile: isMobile }"
		>
			<!-- Info button - mobile only, integrated into search bar -->
			<button
				v-if="isMobile"
				class="search-action-btn search-action-btn-start"
				@click="emit('about-click')"
				:title="$t('about.openInfo')"
			>
				<ion-icon :icon="informationCircle" class="search-icon-btn"></ion-icon>
			</button>
			<!-- ios26-disabled: the row itself carries the pill/glass style, so the
			     iOS 26 theme must not draw its own inner glass pill on the input -->
			<ion-searchbar
				:value="searchQuery"
				:placeholder="$t('addressSearch.placeholder')"
				:disabled="!isOnline"
				:debounce="0"
				show-clear-button="always"
				@ionInput="onSearchInput"
				@ionClear="onSearchClear"
				@ionFocus="onSearchFocus"
				@ionBlur="onSearchBlur"
				class="search-bar ios26-disabled"
				:class="{ 'search-bar-mobile': isMobile }"
			></ion-searchbar>
			<!-- Loading indicator inside the bar area -->
			<ion-spinner
				v-if="searchLoading"
				name="crescent"
				color="primary"
				class="search-spinner"
			></ion-spinner>
			<!-- Settings button - mobile only -->
			<button
				v-if="isMobile"
				class="search-action-btn search-action-btn-end"
				@click="emit('settings-click')"
				:title="$t('settings.title')"
			>
				<ion-icon :icon="settingsIcon" class="search-icon-btn"></ion-icon>
			</button>
		</div>
		<!-- Offline hint: address search needs a connection -->
		<div v-if="!isOnline" class="search-offline-hint">
			<ion-icon :icon="cloudOfflineOutline"></ion-icon>
			<span>{{ $t('addressSearch.offlineHint') }}</span>
		</div>
		<!-- Search Results -->
		<div v-if="isOnline && showSearchResults && searchResults.length > 0" class="search-results">
			<div
				v-for="(feature, index) in searchResults"
				:key="index"
				class="search-result-item"
				@click="onSelectResult(feature)"
			>
				<div class="result-name">{{ getFeatureName(feature) }}</div>
				<div class="result-address">{{ formatAddress(feature) }}</div>
			</div>
		</div>
		<!-- No results message -->
		<div
			v-if="
				isOnline &&
				showSearchResults &&
				searchResults.length === 0 &&
				!searchLoading &&
				searchQuery.length >= 2
			"
			class="search-results"
		>
			<div class="search-no-results">{{ $t('addressSearch.noResults') }}</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import { IonIcon, IonSearchbar, IonSpinner } from '@ionic/vue';
import { cloudOfflineOutline, informationCircle, settings as settingsIcon } from 'ionicons/icons';
import { type PhotonFeature, usePhotonSearch } from '@/composable/photonSearch';
import { useScreenDetection } from '@/composable/screenDetection';
import { useNetworkStatus } from '@/composable/networkStatus';
import { useI18n } from 'vue-i18n';
import { debounce } from '@/helper/helper';

const props = defineProps<{
	mapCenter?: { lat: number; lng: number };
}>();

const emit = defineEmits<{
	(e: 'select-result', feature: PhotonFeature): void;
	(e: 'about-click'): void;
	(e: 'settings-click'): void;
	(e: 'clear-search'): void;
}>();

const { locale } = useI18n();
const { isMobile } = useScreenDetection();
const { isOnline } = useNetworkStatus();
const {
	query: searchQuery,
	results: searchResults,
	isLoading: searchLoading,
	searchPhoton,
	clearSearch,
	formatAddress,
	getFeatureName
} = usePhotonSearch();

const showSearchResults = ref(false);

// Whichever panel is currently attached below the bar (results dropdown or
// the offline hint) needs the bar's bottom corners flattened so the two
// read as one continuous sheet instead of two stacked pills.
const hasAttachedPanel = computed(
	() => (showSearchResults.value && searchResults.value.length > 0) || !isOnline.value
);

const debouncedSearch = debounce((text: string) => {
	if (!text || text.trim().length < 2) {
		searchResults.value = [];
		showSearchResults.value = false;
		return;
	}
	const lang = locale.value === 'de' ? 'de' : 'en';
	searchPhoton(text, lang, props.mapCenter?.lat, props.mapCenter?.lng);
	showSearchResults.value = true;
}, 300);

function onSearchInput(event: CustomEvent) {
	const text = event.detail.value || '';
	searchQuery.value = text;
	if (!text || text.trim().length < 2) {
		searchResults.value = [];
		showSearchResults.value = false;
		return;
	}
	debouncedSearch(text);
}

function onSearchClear() {
	clearSearch();
	showSearchResults.value = false;
	emit('clear-search');
}

function onSearchFocus() {
	// Show results again if there are results and query is long enough
	if (searchResults.value.length > 0 && searchQuery.value.length >= 2) {
		showSearchResults.value = true;
	}
}

function onSearchBlur() {
	// Delay hiding to allow click on results to register
	setTimeout(() => {
		showSearchResults.value = false;
	}, 200);
}

function onSelectResult(feature: PhotonFeature) {
	searchQuery.value = getFeatureName(feature);
	showSearchResults.value = false;
	emit('select-result', feature);
}
</script>

<style scoped>
.search-container {
	position: absolute;
	top: 10px;
	left: 50%;
	transform: translateX(-50%);
	z-index: 1001;
	width: 100%;
	max-width: 656px;
	padding: calc(var(--ion-safe-area-top, env(safe-area-inset-top, 0px)) + 8px) 16px 0 16px;
	pointer-events: none;
}

.search-container > * {
	pointer-events: auto;
}

.search-bar-row {
	display: flex;
	align-items: center;
	gap: 6px;
	background: var(--md-sys-surface-container-lowest);
	--background: var(--md-sys-surface-container-lowest);
	--color: var(--md-sys-on-surface);
	/* One pill around the whole bar (buttons + input), MD3 search bar style */
	border-radius: 28px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
	padding: 0 16px;
	position: relative;

	&.mobile {
		padding: 0 4px !important;
	}
}

/* ios mode: the pill is liquid glass (same recipe as the ios26 theme's
   glass-background mixin, driven by its --ios26-* variables) */
html[mode='ios'] .search-bar-row {
	background: rgba(var(--ios26-glass-background-rgb), 0.72);
	backdrop-filter: blur(2px) saturate(360%);
	box-shadow:
		inset 0 0 8px 0 rgba(var(--ios26-glass-box-shadow-color-rgb), 0.2),
		0 0 10px 0 rgba(var(--ios26-glass-box-shadow-color-rgb), 0.82);
	border: 0.5px solid rgba(var(--ios26-glass-border-color-rgb), 0.8);
}

.search-bar-row.has-attached-panel {
	border-radius: 24px 24px 0 0;
}

.search-bar {
	--background: transparent !important;
	--box-shadow: none !important;
	--border-radius: 24px;
	padding: 0;
	flex: 1;
	min-width: 0;
	min-height: 40px;
}

.search-bar-mobile {
	--padding-start: 0;
}

/* Deep overrides for Ionic MD searchbar internal elements */
.search-bar :deep(.searchbar-input) {
	border: 0 !important;
}
.search-spinner {
	width: 20px;
	height: 20px;
	margin-right: 8px;
	flex-shrink: 0;
}

.search-action-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	border-radius: 50%;
	border: none;
	background: transparent;
	color: var(--md-sys-on-surface);
	cursor: pointer;
	flex-shrink: 0;
	padding: 0;
	-webkit-tap-highlight-color: transparent;
}

.search-action-btn:active {
	background: rgba(0, 0, 0, 0.08);
}

.search-action-btn ion-icon {
	font-size: 22px;
	color: inherit;
	opacity: 1 !important;
}

.search-icon-btn {
	opacity: 1 !important;
}

.search-action-btn-start {
	margin-left: 4px;
}

.search-action-btn-end {
	margin-right: 0;
}

.search-results {
	/* Same surface as the bar so the open state reads as one element */
	background: var(--md-sys-surface-container-lowest);
	--background: var(--md-sys-surface-container-lowest);
	--color: var(--md-sys-on-surface);
	--box-shadow: var(--md-sys-level2);
	border-radius: 0 0 24px 24px;
	box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
	overflow: hidden;
	max-height: 260px;
	overflow-y: auto;
	border-top: 1px solid rgba(0, 0, 0, 0.08);
}

/* ios mode: results continue the bar's liquid glass */
html[mode='ios'] .search-results,
html[mode='ios'] .search-offline-hint {
	background: rgba(var(--ios26-glass-background-rgb), 0.72);
	backdrop-filter: blur(2px) saturate(360%);
	box-shadow:
		inset 0 0 8px 0 rgba(var(--ios26-glass-box-shadow-color-rgb), 0.2),
		0 0 10px 0 rgba(var(--ios26-glass-box-shadow-color-rgb), 0.82);
	border: 0.5px solid rgba(var(--ios26-glass-border-color-rgb), 0.8);
	border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.search-result-item {
	padding: 8px 16px;
	cursor: pointer;
	transition: background-color 0.15s ease;
}

.search-result-item:active,
.search-result-item:hover {
	--background-hover: var(--md-sys-surface-container);
	background: var(--md-sys-surface-container);
}

.search-result-item + .search-result-item {
	border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.result-name {
	font-weight: 600;
	font-size: 14px;
	line-height: 1.3;
}

.result-address {
	font-size: 12px;
	line-height: 1.3;
	margin-top: 1px;
}

.search-no-results {
	padding: 12px 16px;
	font-size: 13px;
	text-align: center;
}

.search-offline-hint {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	background: var(--md-sys-surface-container-lowest);
	--background: var(--md-sys-surface-container-lowest);
	/* Real color property — a --color custom prop has no effect on plain spans */
	color: var(--md-sys-on-surface);
	padding: 10px 16px;
	font-size: 13px;
	border-radius: 0 0 24px 24px;
	box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
	border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.search-offline-hint ion-icon {
	/* ion-icon sizes off font-size (1em); without this it inherits the
	   hint's small 13px text size instead of reading as an icon */
	font-size: 20px;
	flex-shrink: 0;
	margin-top: 1px;
}
</style>
