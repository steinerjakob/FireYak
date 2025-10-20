<script setup lang="ts">
import { ref, watch } from 'vue';
import { IonContent, IonCard, IonModal } from '@ionic/vue';
import { useScreenOrientation } from '@/composable/screenOrientation';
import SupplyPipeCalculationHeader from '@/components/SupplyPipeCalculationHeader.vue';
import { usePumpCalculation } from '@/composable/pumpCalculation';

const modal = ref();
const screenOrientation = useScreenOrientation();
const { isActive } = usePumpCalculation();

const isMobile = ref(window.innerWidth < 768);

watch(screenOrientation.orientation, () => {
	isMobile.value = window.innerWidth < 768;
});
</script>

<template>
	<template v-if="isMobile">
		<ion-modal
			ref="modal"
			:is-open="isActive"
			:breakpoints="[0.25, 0.4, 0.5, 0.75]"
			:initial-breakpoint="0.4"
			:backdrop-dismiss="false"
			:backdrop-opacity="0"
			:showBackdrop="false"
			:expand-to-scroll="false"
			handle-behavior="cycle"
			class="supply-pipe"
		>
			<SupplyPipeCalculationHeader></SupplyPipeCalculationHeader>
			<ion-content> </ion-content>
		</ion-modal>
	</template>
	<ion-card v-else-if="isActive" class="desktop-card">
		<SupplyPipeCalculationHeader></SupplyPipeCalculationHeader
	></ion-card>
</template>

<style scoped>
.supply-pipe {
	--height: 100%;
	--width: 100%;
	--backdrop-opacity: 0;
}

.desktop-card {
	position: fixed;
	left: 0;
	top: 0;
	bottom: 0;
	width: 400px;
	z-index: 1000;

	border-radius: 0;
	overflow-y: auto;
}

@media (max-width: 767px) {
	.supply-pipe::part(content) {
		border-radius: 8px 8px 0 0;
		box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.1);
	}
}
</style>
