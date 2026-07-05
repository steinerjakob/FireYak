<template>
	<ion-app>
		<ion-router-outlet />
		<UpdateToast></UpdateToast>
		<NativeAppInstallPrompt />
	</ion-app>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import UpdateToast from '@/components/UpdateToast.vue';
import NativeAppInstallPrompt from '@/components/NativeAppInstallPrompt.vue';
import { useSettings } from '@/composable/settings';
import { useInAppReview } from '@/composable/inAppReview';
import { pruneStaleMapNodes } from '@/mapHandler/databaseHandler';
import { useOfflineAreasStore } from '@/store/offlineAreasStore';
import { useNetworkStatus } from '@/composable/networkStatus';

// Load user settings from storage on app startup
const { loadSettings } = useSettings();
loadSettings();

// Number of days a cached water source is kept before it is pruned.
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Track active usage days and auto-prompt for review (one-shot)
const { recordActiveDay, tryAutoPrompt } = useInAppReview();

// Offline areas: load records and run the Wi-Fi auto-refresh check on startup,
// and re-check whenever connectivity is regained.
const offlineAreasStore = useOfflineAreasStore();
const { onOnline } = useNetworkStatus();
onOnline(() => offlineAreasStore.checkAutoRefresh());

onMounted(async () => {
	// Fire-and-forget: drop cache entries older than 90 days so the local
	// IndexedDB store doesn't grow unboundedly as the user pans around.
	// Nodes inside a downloaded offline area are exempt from pruning.
	pruneStaleMapNodes(CACHE_MAX_AGE_MS);

	// Fire-and-forget: hydrate the offline-areas store (also triggers auto-refresh).
	offlineAreasStore.init();

	await recordActiveDay();
	await tryAutoPrompt();
});
</script>
