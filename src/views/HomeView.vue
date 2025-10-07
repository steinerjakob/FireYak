<template>
	<ion-page>
		<ion-header :translucent="true">
			<ion-toolbar>
				<ion-title>Blank</ion-title>
			</ion-toolbar>
		</ion-header>

		<ion-content :fullscreen="true">
			<ion-header collapse="condense">
				<ion-toolbar>
					<ion-title size="large">Blank</ion-title>
				</ion-toolbar>
			</ion-header>

			<MainMap></MainMap>
			<MarkerInfo></MarkerInfo>
		</ion-content>
	</ion-page>
</template>

<script lang="ts" setup>
import { IonPage, IonHeader, IonToolbar, IonTitle, IonContent } from '@ionic/vue';
import MainMap from '@/components/MainMap.vue';
import MarkerInfo from '@/components/MarkerInfo.vue';
</script>

<style scoped>
#container {
	width: 100%;
	height: 100%;
	display: flex;
	flex-direction: row;
}
</style>
