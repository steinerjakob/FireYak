<template>
	<ion-page>
		<ion-header>
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
				</div>

				<ion-card>
					<ion-card-header>
						<ion-card-title>{{ $t('about.title') }}</ion-card-title>
					</ion-card-header>
					<ion-card-content>
						<p>{{ $t('about.description') }}</p>
					</ion-card-content>
				</ion-card>

				<!-- How to add hydrants to OpenStreetMap -->
				<ion-card>
					<ion-card-header>
						<ion-card-title>
							<ion-icon
								:icon="documentText"
								style="vertical-align: middle; margin-right: 8px"
							></ion-icon>
							{{ $t('about.addHydrantsTitle') }}
						</ion-card-title>
					</ion-card-header>
					<ion-card-content>
						<p class="ion-text-wrap">
							{{ $t('about.addHydrantsDescription') }}
						</p>

						<ion-button
							expand="block"
							fill="outline"
							href="https://github.com/steinerjakob/FireYak#how-to-add-a-fire-hydrant-or-other-water-source-to-openstreetmap"
							target="_blank"
						>
							<ion-icon :icon="documentText" slot="start"></ion-icon>
							{{ $t('about.addHydrantsOpenReadme') }}
						</ion-button>
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
						<p>{{ $t('about.buyMeCoffeeDescription') }}</p>

						<a href="https://www.buymeacoffee.com/steinerjakob" target="_blank" class="coffee-link">
							<img
								src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
								alt="Buy Me A Coffee"
								class="coffee-button-img"
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
import { logoGithub, heart, star, bug, code, documentText, map } from 'ionicons/icons';
import { onMounted, ref } from 'vue';
import { App } from '@capacitor/app';
import { AppInfo } from '@capacitor/app/dist/esm/definitions';
import { Capacitor } from '@capacitor/core';
import { version } from '@/../package.json';

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

.coffee-link {
	display: block;
	margin-top: 16px;
	text-align: center;
}

.coffee-button-img {
	height: 60px;
	width: auto;
	max-width: 100%;
	transition: transform 0.2s;
}

.coffee-button-img:hover {
	transform: scale(1.05);
}
</style>
