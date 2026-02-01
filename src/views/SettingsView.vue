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
				<ion-list-header>
					<ion-label>{{ $t('settings.appearance.title') }}</ion-label>
				</ion-list-header>

				<ion-item>
					<ion-label>{{ $t('settings.appearance.theme.title') }}</ion-label>
					<ion-segment :value="theme" @ion-change="onThemeChange($event)">
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
	SegmentCustomEvent,
	ToggleCustomEvent
} from '@ionic/vue';
import { useSettingsStore, type ThemeSetting } from '@/store/settingsStore';
import { useSettings } from '@/composable/settings';
import { storeToRefs } from 'pinia';

const settingsStore = useSettingsStore();
const { saveTheme, saveShowZoomButtons } = useSettings();
const { theme, showZoomButtons } = storeToRefs(settingsStore);

const onThemeChange = (event: SegmentCustomEvent) => {
	saveTheme(event.detail.value as ThemeSetting);
};

const onShowZoomButtonsChange = (event: ToggleCustomEvent) => {
	saveShowZoomButtons(event.detail.checked);
};
</script>
