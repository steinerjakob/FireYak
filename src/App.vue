<template>
	<ion-app>
		<ion-router-outlet />
		<UpdateToast></UpdateToast>
		<NativeAppInstallPrompt />
		<WhatsNewModal />
	</ion-app>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import UpdateToast from '@/components/UpdateToast.vue';
import NativeAppInstallPrompt from '@/components/NativeAppInstallPrompt.vue';
import WhatsNewModal from '@/components/WhatsNewModal.vue';
import { useSettings } from '@/composable/settings';
import { useInAppReview } from '@/composable/inAppReview';
import { useWhatsNew } from '@/composable/whatsNew';
import { pruneStaleMapNodes } from '@/mapHandler/databaseHandler';
import { useOfflineAreasStore } from '@/store/offlineAreasStore';
import { usePendingEditsStore } from '@/store/pendingEditsStore';
import { useNetworkStatus } from '@/composable/networkStatus';

// Load user settings from storage on app startup
const { loadSettings } = useSettings();
loadSettings();

// Number of days a cached water source is kept before it is pruned.
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Track active usage days and auto-prompt for review (one-shot)
const { recordActiveDay, tryAutoPrompt } = useInAppReview();
const { checkForUpdate } = useWhatsNew();

// Offline areas: load records and run the Wi-Fi auto-refresh check on startup,
// and re-check whenever connectivity is regained.
const offlineAreasStore = useOfflineAreasStore();
// Offline edit queue: drain queued edits on startup and on every reconnect.
const pendingEditsStore = usePendingEditsStore();
const { onOnline } = useNetworkStatus();
onOnline(() => {
	offlineAreasStore.checkAutoRefresh();
	pendingEditsStore.sync();
});

onMounted(async () => {
	// Fire-and-forget: drop cache entries older than 90 days so the local
	// IndexedDB store doesn't grow unboundedly as the user pans around.
	// Nodes inside a downloaded offline area are exempt from pruning.
	pruneStaleMapNodes(CACHE_MAX_AGE_MS);

	// Fire-and-forget: hydrate the offline-areas store (also triggers auto-refresh).
	offlineAreasStore.init();

	// Fire-and-forget: hydrate the pending-edits queue and attempt a sync.
	pendingEditsStore.init();

	// What's New wins: if it's showing this session, skip the review prompt so
	// a user reading release notes doesn't immediately get a rating dialog.
	const showingWhatsNew = await checkForUpdate();

	await recordActiveDay();
	if (!showingWhatsNew) {
		await tryAutoPrompt();
	}
});
</script>
