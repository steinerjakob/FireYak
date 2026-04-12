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

// Load user settings from storage on app startup
const { loadSettings } = useSettings();
loadSettings();

// Track active usage days and auto-prompt for review (one-shot)
const { recordActiveDay, tryAutoPrompt } = useInAppReview();
onMounted(async () => {
	await recordActiveDay();
	await tryAutoPrompt();
});
</script>
