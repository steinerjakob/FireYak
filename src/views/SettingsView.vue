<template>
	<ion-page>
		<ion-header>
			<ion-toolbar>
				<ion-buttons slot="start">
					<ion-back-button default-href="/"></ion-back-button>
				</ion-buttons>
				<ion-title>{{ $t('settings.title') }}</ion-title>
			</ion-toolbar>
		</ion-header>
		<ion-content>
			<ion-list>
				<!-- Appearance Section -->
				<ion-list-header>
					<ion-label>{{ $t('settings.appearance.title') }}</ion-label>
				</ion-list-header>

				<ion-item>
					<ion-segment
						:value="theme"
						@ion-change="onThemeChange($event)"
						style="padding-left: 8px; padding-right: 8px"
					>
						<ion-segment-button value="light">
							<ion-label>{{ $t('settings.appearance.theme.light') }}</ion-label>
						</ion-segment-button>
						<ion-segment-button value="dark">
							<ion-label>{{ $t('settings.appearance.theme.dark') }}</ion-label>
						</ion-segment-button>
						<ion-segment-button value="auto">
							<ion-label>{{ $t('settings.appearance.theme.auto') }}</ion-label>
						</ion-segment-button>
					</ion-segment>
				</ion-item>

				<!-- Map Section -->
				<ion-list-header>
					<ion-label>{{ $t('settings.map.title') }}</ion-label>
				</ion-list-header>

				<ion-item>
					<ion-label>{{ $t('settings.map.showZoomButtons') }}</ion-label>
					<ion-toggle
						slot="end"
						:checked="showZoomButtons"
						@ion-change="onShowZoomButtonsChange($event)"
					></ion-toggle>
				</ion-item>

				<!-- Account Section -->
				<ion-list-header>
					<ion-label>{{ $t('settings.account.title') }}</ion-label>
				</ion-list-header>

				<ion-item v-if="osmAuthStore.isAuthenticated" lines="none">
					<ion-label>
						<h2>{{ $t('settings.account.osmAccount') }}</h2>
						<p>
							{{ $t('settings.account.loggedInAs', { name: osmAuthStore.user?.display_name }) }}
						</p>
					</ion-label>
				</ion-item>

				<ion-item v-if="osmAuthStore.isAuthenticated" lines="none">
					<ion-button fill="primary" @click="openOsmProfile()">
						<ion-icon slot="start" :icon="openOutline"></ion-icon>
						{{ $t('settings.account.manageAccount') }}
					</ion-button>
					<ion-button slot="end" fill="outline" @click="osmAuthStore.logout()">
						<ion-icon slot="start" :icon="logOutOutline"></ion-icon>
						{{ $t('markerEdit.buttons.logout') }}
					</ion-button>
				</ion-item>

				<ion-item v-else lines="none">
					<ion-label>
						<p>{{ $t('settings.account.loginDescription') }}</p>
					</ion-label>
				</ion-item>
			<ion-item v-if="!osmAuthStore.isAuthenticated" lines="none">
				<ion-button expand="block" @click="osmAuthStore.login()">
					<ion-icon slot="start" :icon="logInOutline"></ion-icon>
					{{ $t('markerEdit.buttons.login') }}
				</ion-button>
			</ion-item>

			<!-- Wikimedia Commons Account -->
			<ion-list-header>
				<ion-label>{{ $t('settings.account.wikimediaTitle') }}</ion-label>
			</ion-list-header>

			<ion-item v-if="wikimediaAuthStore.isAuthenticated" lines="none">
				<ion-label>
					<h2>{{ $t('settings.account.wikimediaAccount') }}</h2>
					<p>{{ wikimediaAuthStore.user?.name }}</p>
				</ion-label>
				<ion-button slot="end" fill="clear" @click="wikimediaAuthStore.logout()">
					<ion-icon slot="start" :icon="logOutOutline"></ion-icon>
					{{ $t('wikimediaAuth.buttons.logout') }}
				</ion-button>
			</ion-item>

			<ion-item v-else lines="none">
				<ion-label class="ion-text-wrap">
					<p>{{ $t('settings.account.wikimediaLoginDescription') }}</p>
				</ion-label>
			</ion-item>
			<ion-item v-if="!wikimediaAuthStore.isAuthenticated" lines="none">
				<ion-button expand="block" @click="wikimediaAuthStore.login()">
					<ion-icon slot="start" :icon="logInOutline"></ion-icon>
					{{ $t('wikimediaAuth.buttons.login') }}
				</ion-button>
			</ion-item>
		</ion-list>
		</ion-content>
	</ion-page>
</template>

<script setup lang="ts">
import {
	IonPage,
	IonHeader,
	IonToolbar,
	IonButtons,
	IonBackButton,
	IonTitle,
	IonContent,
	IonList,
	IonListHeader,
	IonItem,
	IonLabel,
	IonSegment,
	IonSegmentButton,
	IonToggle,
	IonButton,
	IonIcon,
	SegmentCustomEvent,
	ToggleCustomEvent
} from '@ionic/vue';
import { logInOutline, logOutOutline, openOutline } from 'ionicons/icons';
import { useSettingsStore, type ThemeSetting } from '@/store/settingsStore';
import { useSettings } from '@/composable/settings';
import { useOsmAuthStore } from '@/store/osmAuthStore';
import { useWikimediaAuthStore } from '@/store/wikimediaAuthStore';
import { storeToRefs } from 'pinia';
import { Capacitor } from '@capacitor/core';

const settingsStore = useSettingsStore();
const { saveTheme, saveShowZoomButtons } = useSettings();
const { theme, showZoomButtons } = storeToRefs(settingsStore);
const osmAuthStore = useOsmAuthStore();
const wikimediaAuthStore = useWikimediaAuthStore();

const onThemeChange = (event: SegmentCustomEvent) => {
	saveTheme(event.detail.value as ThemeSetting);
};

const onShowZoomButtonsChange = (event: ToggleCustomEvent) => {
	saveShowZoomButtons(event.detail.checked);
};

const OSM_ACCOUNT_URL = 'https://www.openstreetmap.org/account/edit';

/**
 * Opens the OpenStreetMap account profile page.
 * On native platforms, uses InAppBrowser (WebView) so session cookies from the
 * OAuth login flow may auto-login the user. On web, opens a new browser tab.
 */
const openOsmProfile = async () => {
	if (Capacitor.isNativePlatform()) {
		const { InAppBrowser, DefaultWebViewOptions } = await import('@capacitor/inappbrowser');
		await InAppBrowser.openInWebView({
			url: OSM_ACCOUNT_URL,
			options: DefaultWebViewOptions
		});
	} else {
		window.open(OSM_ACCOUNT_URL, '_blank');
	}
};
</script>
