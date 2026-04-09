<template>
	<ion-modal
		:is-open="isOpen"
		:backdrop-dismiss="false"
		:show-backdrop="true"
		@did-dismiss="handleDismiss"
		class="native-app-dialog"
	>
		<div class="dialog-container">
			<div class="dialog-header">
				<div class="app-icon">
					<ion-img src="/icons/icon-96.webp" style="max-width: 72px" />
				</div>
			</div>

			<div class="dialog-content">
				<ion-text>{{ t('nativeApp.headline') }} </ion-text>
			</div>

			<div class="dialog-actions">
				<ion-img :src="appStoreBadge" @click="openAppStore"></ion-img>
				<ion-button expand="block" fill="clear" @click="handleDismiss" class="secondary-action">
					{{ t('nativeApp.continueWeb') }}
				</ion-button>
			</div>
		</div>
	</ion-modal>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Capacitor } from '@capacitor/core';
import { IonModal, IonButton, IonImg, IonText, isPlatform } from '@ionic/vue';
import { Preferences } from '@capacitor/preferences';
import { APP_STORE_URLS } from '@/helper/appStoreInfos';
const { t, locale } = useI18n();

const isOpen = ref(false);

const STORAGE_KEY = 'native_app_prompt_dismissed';
const PROMPT_DELAY = 2000; // 2 seconds delay

onMounted(() => {
	setTimeout(() => {
		checkAndShowPrompt();
	}, PROMPT_DELAY);
});

const checkAndShowPrompt = async () => {
	// Only show on ios and android web platform
	if (Capacitor.isNativePlatform() || (!isPlatform('android') && !isPlatform('ios'))) {
		return;
	}

	// Check if user has already dismissed the prompt
	const dismissed = await Preferences.get({ key: STORAGE_KEY });
	if (dismissed.value === 'true') {
		return;
	}

	showDialog();
};

/**
 * A computed property that generates the path to the appropriate app store badge asset,
 * tailored to the user's platform and locale. The file format is determined
 * based on the platform, with 'svg' for iOS and 'png' for other platforms.
 *
 * The path follows the structure:
 * `/assets/downloadBadges/{platform}/{locale}.{fileExtension}`
 */
const appStoreBadge = computed(() => {
	const fileExtension = isPlatform('ios') ? 'svg' : 'png';
	const simpleLocale = locale.value.split('-')[0];
	const patchedLocale = ['en', 'de'].includes(simpleLocale) ? simpleLocale : 'en';
	const platform = isPlatform('ios') ? 'ios' : 'android';
	return `/assets/downloadBadges/${platform}/${patchedLocale}.${fileExtension}`;
});

const showDialog = () => {
	isOpen.value = true;
};

const openAppStore = async () => {
	const url = isPlatform('ios') ? APP_STORE_URLS.ios : APP_STORE_URLS.android;

	window.open(url, '_blank');
};

const handleDismiss = async () => {
	isOpen.value = false;
	// Remember that the user dismissed the prompt
	await Preferences.set({ key: STORAGE_KEY, value: 'true' });
};
</script>

<style scoped>
.native-app-dialog {
	--width: fit-content;
	--backdrop-opacity: 0.4;
	--height: auto;
	--max-height: 80vh;
	--border-radius: 16px;
	--box-shadow: 0 10px 40px rgb(0 0 0 / 20%);

	padding: 16px;
}

.dialog-container {
	background: var(--ion-color-background);
	border-radius: 16px;
	overflow: hidden;
	max-width: 400px;
	margin: 0 auto;
	position: relative;
}

.dialog-header {
	position: relative;
	padding: 24px 24px 0;
	text-align: center;
	display: flex;
	justify-content: center;
	align-items: flex-start;
}

.app-icon {
	margin-bottom: 8px;
	flex: 1;
	display: flex;
	justify-content: center;
}

.app-icon ion-img {
	border-radius: 12px;
	overflow: hidden;
}

.dialog-content {
	padding: 8px 16px;
	text-align: center;
}

h2 {
	font-size: 20px;
	font-weight: 600;
	margin-bottom: 12px;
	color: var(--ion-color-primary);
	line-height: 1.3;
}

.description {
	font-size: 14px;
	line-height: 1.4;
	margin-bottom: 20px;
	color: var(--ion-color-medium);
}

.benefit-item ion-icon {
	font-size: 16px;
	flex-shrink: 0;
}

.benefit-item span {
	font-size: 13px;
	color: var(--ion-color-dark);
	line-height: 1.3;
}

.dialog-actions {
	padding: 0 24px 24px;
	display: flex;
	flex-direction: column;
	gap: 8px;
	width: 100%;
	justify-content: center;
	align-items: center;

	ion-img {
		width: 200px;
	}
}

.primary-action {
	--background: var(--ion-color-primary);
	--color: white;
	--border-radius: 12px;

	font-weight: 600;
	height: 44px;
}

.secondary-action {
	--color: var(--ion-color-medium);
	--border-radius: 12px;

	height: 40px;
	font-size: 14px;
}

/* Responsive adjustments */
@media (width <= 480px) {
	.dialog-container {
		margin: 16px;
		max-width: calc(100vw - 32px);
	}

	.dialog-header {
		padding: 20px 20px 0;
	}

	.dialog-content {
		padding: 12px 20px;
	}

	.dialog-actions {
		padding: 0 20px 0;
	}

	h2 {
		font-size: 18px;
	}

	.description {
		font-size: 13px;
	}

	.benefit-item span {
		font-size: 12px;
	}
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
	.dialog-container {
		--ion-color-background: var(--ion-color-dark);

		border: 1px solid var(--ion-color-medium-shade);
	}
}
</style>
