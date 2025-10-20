<template>
	<ion-page>
		<ion-content :fullscreen="true">
			<MainMap></MainMap>
			<MarkerInfoPanel></MarkerInfoPanel>
			<SupplyPipeCalculation></SupplyPipeCalculation>
		</ion-content>
	</ion-page>
</template>

<script lang="ts" setup>
import { IonPage, IonContent } from '@ionic/vue';
import MainMap from '@/components/MainMap.vue';
import MarkerInfoPanel from '@/components/MarkerInfoPanel.vue';
import SupplyPipeCalculation from '@/components/SupplyPipeCalculation.vue';
</script>

<style scoped>
#container {
	width: 100%;
	height: 100%;
	display: flex;
	flex-direction: row;
}
</style>
