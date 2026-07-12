<script setup lang="ts">
import { computed } from 'vue';
import { IonModal, IonButton, IonIcon } from '@ionic/vue';
import { sparkles, trendingUp, bug, heart } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import {
	useWhatsNew,
	type WhatsNewEntry,
	type WhatsNewEntryType,
	type WhatsNewRelease
} from '@/composable/whatsNew';

const { t, locale } = useI18n();
const { isOpen, visibleReleases, dismiss } = useWhatsNew();

/** Display order and icon for each entry type; only non-empty groups are rendered. */
const GROUPS: { type: WhatsNewEntryType; icon: string }[] = [
	{ type: 'feature', icon: sparkles },
	{ type: 'improvement', icon: trendingUp },
	{ type: 'fix', icon: bug }
];

const latestVersion = computed(() => visibleReleases.value[0]?.version ?? '');

const entryText = (entry: WhatsNewEntry): string => {
	return locale.value.startsWith('de') ? entry.de : entry.en;
};

const formatDate = (iso: string): string => {
	return new Date(iso).toLocaleDateString(locale.value, {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
};

const groupedEntries = (release: WhatsNewRelease) => {
	return GROUPS.map((group) => ({
		...group,
		entries: release.entries.filter((entry) => entry.type === group.type)
	})).filter((group) => group.entries.length > 0);
};
</script>

<template>
	<ion-modal :is-open="isOpen" class="whats-new-modal" @did-dismiss="dismiss">
		<div class="whats-new-container">
			<div class="whats-new-header">
				<ion-icon :icon="sparkles" class="header-icon"></ion-icon>
				<h2>{{ t('whatsNew.title', { version: latestVersion }) }}</h2>
			</div>

			<div class="whats-new-content">
				<section v-for="release in visibleReleases" :key="release.version" class="release-section">
					<h3 v-if="visibleReleases.length > 1" class="release-heading">
						v{{ release.version }} · {{ formatDate(release.date) }}
					</h3>

					<div v-for="group in groupedEntries(release)" :key="group.type" class="entry-group">
						<h4 class="group-label">
							<ion-icon :icon="group.icon"></ion-icon>
							{{ t(`whatsNew.groups.${group.type}`) }}
						</h4>
						<ul class="entry-list">
							<li v-for="(entry, index) in group.entries" :key="index">{{ entryText(entry) }}</li>
						</ul>
					</div>
				</section>
			</div>

			<div class="whats-new-actions">
				<ion-button
					expand="block"
					fill="outline"
					href="https://ko-fi.com/jakobsteiner"
					target="_blank"
				>
					<ion-icon :icon="heart" slot="start"></ion-icon>
					{{ t('whatsNew.support') }}
				</ion-button>
				<ion-button expand="block" @click="dismiss">{{ t('whatsNew.dismiss') }}</ion-button>
			</div>
		</div>
	</ion-modal>
</template>

<style scoped>
.whats-new-modal {
	--width: min(440px, 92vw);
	--height: auto;
	--max-height: min(640px, 85vh);
	--border-radius: 20px;
	--box-shadow: 0 10px 40px rgb(0 0 0 / 20%);
	--backdrop-opacity: 0.4;
	--background: var(--md-sys-surface-container);
}

/* ios mode: the ios26 theme only glasses sheet modals and popovers, so this
   centered card modal applies the same liquid-glass recipe itself (popover
   variant, driven by the theme's --ios26-* variables, like AddressSearchBar) */
html[mode='ios'] .whats-new-modal {
	--background: transparent;
	--box-shadow: none;
	--backdrop-opacity: 0.2;
}

html[mode='ios'] .whats-new-modal::part(content) {
	/* frosted variant (matches the popover override in theme/ios26-fixes.css):
	   stock glass alpha, but stronger blur than the theme's 2px for readability */
	background: rgba(var(--ios26-glass-background-rgb), 0.72);
	backdrop-filter: blur(4px) saturate(220%);
	box-shadow:
		inset 0 0 8px 0 rgba(var(--ios26-glass-box-shadow-color-rgb), 0.2),
		0 0 10px 0 rgba(var(--ios26-glass-box-shadow-color-rgb), 0.82);
	border-top: 0.5px solid rgba(var(--ios26-glass-border-color-rgb), 1);
	border-right: 0.5px solid rgba(var(--ios26-glass-border-color-rgb), 0.8);
	border-bottom: 0.5px solid rgba(var(--ios26-glass-border-color-rgb), 1);
	border-left: 0.5px solid rgba(var(--ios26-glass-border-color-rgb), 0.6);
}

/* keep the container transparent so the modal surface (glass on ios, MD3
   surface-container on md) shows through */
.whats-new-container {
	color: var(--md-sys-on-surface);
	display: flex;
	flex-direction: column;
	max-height: min(640px, 85vh);
}

.whats-new-header {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 24px 24px 8px;
	flex-shrink: 0;
}

.header-icon {
	font-size: 24px;
	color: var(--ion-color-primary);
	flex-shrink: 0;
}

.whats-new-header h2 {
	margin: 0;
	font-size: 20px;
	font-weight: 600;
	line-height: 1.3;
}

.whats-new-content {
	overflow-y: auto;
	padding: 8px 24px;
}

.release-section + .release-section {
	margin-top: 20px;
	padding-top: 16px;
	border-top: 1px solid var(--md-sys-outline-variant);
}

.release-heading {
	margin: 0 0 8px;
	font-size: 13px;
	font-weight: 600;
	color: var(--md-sys-on-surface-variant);
}

.entry-group {
	margin-top: 12px;
}

.entry-group:first-child {
	margin-top: 0;
}

.group-label {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0 0 6px;
	font-size: 13px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--md-sys-on-surface-variant);
}

.group-label ion-icon {
	font-size: 16px;
}

.entry-list {
	margin: 0;
	padding-left: 20px;
	list-style: disc;
}

.entry-list li {
	font-size: 14px;
	line-height: 1.5;
	margin-bottom: 4px;
}

.whats-new-actions {
	padding: 16px 24px 24px;
	flex-shrink: 0;
}

.whats-new-actions ion-button + ion-button {
	margin-top: 8px;
}
</style>
