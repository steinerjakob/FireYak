<script setup lang="ts">
import { IonToast, ToastButton } from '@ionic/vue';
import { ref } from 'vue';
import { registerSW } from 'virtual:pwa-register';

// Declare the global constant injected by vite.config.ts
declare const __BUILD_TARGET_NATIVE__: boolean;

// Check if this is a native build - used for controlling update toast visibility
const isNativeBuild = typeof __BUILD_TARGET_NATIVE__ !== 'undefined' && __BUILD_TARGET_NATIVE__;

const intervalMS = 60 * 60 * 1000;

const needRefresh = ref(false);

// Register the service worker
// For native builds: VitePWA is configured with selfDestroying=true, which will
// automatically unregister any existing service workers and clear caches
// For web builds: Normal PWA behavior with prompt-based updates
const updateSW = registerSW({
	onNeedRefresh() {
		// Only show refresh prompt for web builds
		// Native builds with selfDestroying mode won't trigger this
		if (!isNativeBuild) {
			needRefresh.value = true;
		}
	},
	onOfflineReady() {},
	onRegisteredSW(swUrl, r) {
		// Only set up periodic update checks for web builds
		if (!isNativeBuild && r) {
			setInterval(async () => {
				if (r.installing || !navigator) {
					return;
				}

				if ('connection' in navigator && !navigator.onLine) {
					return;
				}

				const resp = await fetch(swUrl, {
					cache: 'no-store',
					headers: {
						cache: 'no-store',
						'cache-control': 'no-cache'
					}
				});

				if (resp?.status === 200) {
					await r.update();
				}
			}, intervalMS);
		}
	}
});

const toastButtons: ToastButton[] = [
	{
		text: 'Refresh',
		role: 'info',
		handler: () => {
			updateSW();
		}
	},
	{
		text: 'Close',
		role: 'cancel',
		handler: () => {
			console.log('Dismiss clicked');
		}
	}
];
</script>

<template>
	<ion-toast
		:is-open="needRefresh"
		message="New content is available. Click Refresh to update!"
		:buttons="toastButtons"
	></ion-toast>
</template>
