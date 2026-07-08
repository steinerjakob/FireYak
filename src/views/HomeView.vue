<template>
	<ion-page>
		<!-- ios26-disabled: the map is edge-to-edge; the iOS 26 theme would add
		     60px+safe-area bottom padding to fullscreen content for floating UI -->
		<ion-content :fullscreen="true" class="ios26-disabled">
			<MainMap></MainMap>
			<MarkerInfoPanel></MarkerInfoPanel>
			<MarkerEditPanel></MarkerEditPanel>
			<SupplyPipeCalculationPanel></SupplyPipeCalculationPanel>
			<NearbyMarkerPanel></NearbyMarkerPanel>
		</ion-content>
	</ion-page>
</template>

<script lang="ts" setup>
import { IonPage, IonContent } from '@ionic/vue';
import MainMap from '@/components/MainMap.vue';
import MarkerInfoPanel from '@/components/MarkerInfoPanel.vue';
import MarkerEditPanel from '@/components/MarkerEditPanel.vue';
import SupplyPipeCalculationPanel from '@/components/SupplyPipeCalculationPanel.vue';
import NearbyMarkerPanel from '@/components/NearbyMarkerPanel.vue';
</script>

<style scoped>
#container {
	width: 100%;
	height: 100%;
	display: flex;
	flex-direction: row;
}
</style>
