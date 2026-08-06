<template>
	<ion-app>
		<ion-router-outlet />
		<UpdateToast></UpdateToast>
		<NativeAppInstallPrompt />
		<WhatsNewModal />
	</ion-app>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import { App as CapacitorApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
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

/** How long housekeeping waits for an idle moment before running anyway. */
const IDLE_TASK_TIMEOUT_MS = 10_000;

/**
 * Runs background housekeeping once the main thread has nothing better to do.
 * Falls back to a plain timeout on engines without `requestIdleCallback`
 * (notably iOS WebKit, which is exactly where a blocked main thread hurts most).
 */
function runWhenIdle(task: () => void): void {
	if (typeof window.requestIdleCallback === 'function') {
		window.requestIdleCallback(task, { timeout: IDLE_TASK_TIMEOUT_MS });
	} else {
		window.setTimeout(task, IDLE_TASK_TIMEOUT_MS / 2);
	}
}

// Track active usage days and auto-prompt for review (one-shot)
const { recordActiveDay, scheduleAutoPrompt, cancelAutoPrompt } = useInAppReview();
const { checkForUpdate } = useWhatsNew();

let appStateListener: PluginListenerHandle | undefined;
let appForeground = true;

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
	// Drop cache entries older than 90 days so the local IndexedDB store doesn't
	// grow unboundedly as the user pans around. Nodes inside a downloaded offline
	// area are exempt from pruning.
	//
	// Deferred to idle rather than run here: the prune deletes in `readwrite`
	// transactions, which take an exclusive lock on the marker store, and the map
	// mounts at the same moment and immediately reads it. Started eagerly, the
	// very first viewport read waits on the prune.
	runWhenIdle(() => void pruneStaleMapNodes(CACHE_MAX_AGE_MS));

	// Fire-and-forget: hydrate the offline-areas store (also triggers auto-refresh).
	offlineAreasStore.init();

	// Fire-and-forget: hydrate the pending-edits queue and attempt a sync.
	pendingEditsStore.init();

	await checkForUpdate();

	await recordActiveDay();

	// Resumes far outnumber cold starts, so the counter and the prompt have to
	// run here too — a user who never swipes the app away is otherwise stuck on
	// the day they installed it and would never be asked.
	appStateListener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
		appForeground = isActive;
		if (!isActive) {
			cancelAutoPrompt();
			return;
		}
		// Re-check after the await: the app may have gone back to the background
		// while the day was being recorded, and that path has no timer to cancel.
		void recordActiveDay().then(() => {
			if (appForeground) scheduleAutoPrompt();
		});
	});

	scheduleAutoPrompt();
});

onUnmounted(() => {
	appForeground = false;
	cancelAutoPrompt();
	void appStateListener?.remove();
});
</script>
