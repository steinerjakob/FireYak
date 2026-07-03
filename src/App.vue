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

// Load user settings from storage on app startup
const { loadSettings } = useSettings();
loadSettings();

// Number of days a cached water source is kept before it is pruned.
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Track active usage days and auto-prompt for review (one-shot)
const { recordActiveDay, tryAutoPrompt } = useInAppReview();
onMounted(async () => {
	// Fire-and-forget: drop cache entries older than 90 days so the local
	// IndexedDB store doesn't grow unboundedly as the user pans around.
	pruneStaleMapNodes(CACHE_MAX_AGE_MS);

	await recordActiveDay();
	await tryAutoPrompt();
});
</script>
