<script setup lang="ts">
import { IonToast, ToastButton } from '@ionic/vue';
import { ref } from 'vue';
import { registerSW } from 'virtual:pwa-register';
import { Capacitor } from '@capacitor/core';

const intervalMS = 60 * 60 * 1000;

const needRefresh = ref(false);

const updateSW = registerSW({
	onNeedRefresh() {
		if (Capacitor.isNativePlatform()) {
			return updateSW();
		} else {
			needRefresh.value = true;
		}
	},
	onOfflineReady() {
		// not needed yet
	},
	onRegisteredSW(swUrl, r) {
		if (r) {
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
