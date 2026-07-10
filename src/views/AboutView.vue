<template>
	<ion-page>
		<ion-header :translucent="true">
			<ion-toolbar>
				<ion-buttons slot="start">
					<ion-back-button default-href="/"></ion-back-button>
				</ion-buttons>
				<ion-title>{{ $t('about.title') }}</ion-title>
			</ion-toolbar>
		</ion-header>

		<ion-content :fullscreen="true">
			<div class="about-container">
				<div class="logo-section">
					<img src="/android-chrome-192x192.png" alt="FireYak Logo" class="app-logo" />
					<h1>FireYak</h1>
					<p class="version">
						{{ $t('about.version') }} {{ appInfo?.version }}
						<template v-if="appInfo?.build"> ({{ appInfo.build }}) </template>
					</p>
					<ion-button fill="clear" size="small" @click="openHistory">
						<ion-icon :icon="sparkles" slot="start"></ion-icon>
						{{ $t('whatsNew.aboutLink') }}
					</ion-button>
				</div>

				<ion-card>
					<ion-card-header>
						<ion-card-title>{{ $t('about.title') }}</ion-card-title>
					</ion-card-header>
					<ion-card-content>
						<p>{{ $t('about.description') }}</p>
					</ion-card-content>
				</ion-card>

				<!-- Combined Support Card (Buy Me a Coffee + Support) -->
				<ion-card>
					<ion-card-header>
						<ion-card-title>
							<ion-icon :icon="heart" style="vertical-align: middle; margin-right: 8px"></ion-icon>
							{{ $t('about.support') }}
						</ion-card-title>
					</ion-card-header>
					<ion-card-content>
						<p>{{ $t('about.supportOnKofiDescription') }}</p>

						<a href="https://ko-fi.com/jakobsteiner" target="_blank" class="kofi-link">
							<img
								src="/assets/kofi/support_me_on_kofi_dark.png"
								alt="Support me on Ko-fi"
								class="kofi-button-img kofi-button-light-theme"
							/>
							<img
								src="/assets/kofi/support_me_on_kofi_beige.png"
								alt="Support me on Ko-fi"
								class="kofi-button-img kofi-button-dark-theme"
							/>
						</a>

						<ion-list>
							<ion-item>
								<ion-icon :icon="star" slot="start"></ion-icon>
								<ion-label class="ion-text-wrap">{{ $t('about.starRepo') }}</ion-label>
							</ion-item>
							<ion-item>
								<ion-icon :icon="bug" slot="start"></ion-icon>
								<ion-label class="ion-text-wrap">{{ $t('about.reportIssues') }}</ion-label>
							</ion-item>
							<ion-item>
								<ion-icon :icon="code" slot="start"></ion-icon>
								<ion-label class="ion-text-wrap">{{ $t('about.contributeCode') }}</ion-label>
							</ion-item>
							<ion-item>
								<ion-icon :icon="documentText" slot="start"></ion-icon>
								<ion-label class="ion-text-wrap">{{ $t('about.improveDocs') }}</ion-label>
							</ion-item>
						</ion-list>

						<ion-button
							expand="block"
							href="https://github.com/steinerjakob/FireYak"
							target="_blank"
							class="support-button"
						>
							<ion-icon :icon="logoGithub" slot="start"></ion-icon>
							{{ $t('about.viewOnGitHub') }}
						</ion-button>
					</ion-card-content>
				</ion-card>

				<ion-card>
					<ion-card-header>
						<ion-card-title>
							<ion-icon :icon="map" style="vertical-align: middle; margin-right: 8px"></ion-icon>
							{{ $t('about.dataSource') }}
						</ion-card-title>
					</ion-card-header>
					<ion-card-content>
						<p>{{ $t('about.dataSourceDescription') }}</p>
						<ion-button
							expand="block"
							fill="outline"
							href="https://www.openstreetmap.org"
							target="_blank"
						>
							OpenStreetMap
						</ion-button>
					</ion-card-content>
				</ion-card>
			</div>
		</ion-content>
	</ion-page>
</template>

<script lang="ts" setup>
import {
	IonPage,
	IonHeader,
	IonToolbar,
	IonTitle,
	IonContent,
	IonCard,
	IonCardHeader,
	IonCardTitle,
	IonCardContent,
	IonButton,
	IonIcon,
	IonList,
	IonItem,
	IonLabel,
	IonButtons,
	IonBackButton
} from '@ionic/vue';
import { logoGithub, heart, star, bug, code, documentText, map, sparkles } from 'ionicons/icons';
import { onMounted, ref } from 'vue';
import { App } from '@capacitor/app';
import { AppInfo } from '@capacitor/app/dist/esm/definitions';
import { Capacitor } from '@capacitor/core';
import { version } from '@/../package.json';
import { useWhatsNew } from '@/composable/whatsNew';

const { openHistory } = useWhatsNew();

const appInfo = ref<Partial<AppInfo> | null>(null);

onMounted(async () => {
	if (Capacitor.isNativePlatform()) {
		appInfo.value = await App.getInfo();
	} else {
		appInfo.value = { version: version };
	}
});
</script>

<style scoped>
.about-container {
	max-width: 800px;
	margin: 0 auto;
	padding: 16px;
}

.logo-section {
	text-align: center;
	padding: 32px 16px;
}

.app-logo {
	width: 120px;
	height: 120px;
	margin-bottom: 16px;
}

.logo-section h1 {
	margin: 0;
	font-size: 2rem;
	font-weight: 600;
}

.version {
	margin-top: 4px;
}

ion-card {
	margin-bottom: 16px;
}

.support-button {
	margin-top: 16px;
}

ion-list {
	margin-top: 16px;
	margin-bottom: 0;
}

.kofi-link {
	display: block;
	margin-top: 16px;
	text-align: center;
}

.kofi-button-img {
	height: 48px;
	width: auto;
	max-width: 100%;
	transition: transform 0.2s;
}

.kofi-button-img:hover {
	transform: scale(1.05);
}

/* dark button on light surfaces, beige button on dark surfaces */
.kofi-button-dark-theme {
	display: none;
}

html.ion-palette-dark .kofi-button-light-theme {
	display: none;
}

html.ion-palette-dark .kofi-button-dark-theme {
	display: inline;
}

.rate-app-description {
	margin-top: 20px;
	margin-bottom: 8px;
}
</style>
