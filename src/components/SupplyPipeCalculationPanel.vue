<script setup lang="ts">
import { ref } from 'vue';
import { IonContent, IonCard, IonModal, IonIcon } from '@ionic/vue';
import { useScreenOrientation } from '@/composable/screenOrientation';
import SupplyPipeCalculationHeader from '@/components/SupplyPipeCalculationHeader.vue';
import { usePumpCalculation } from '@/composable/pumpCalculation';
import { locateOutline } from 'ionicons/icons';
import SupplyPipeCalculation from '@/components/SupplyPipeCalculation.vue';
import { useIonModalBreakpoint } from '@/composable/modalBreakpointWatcher';
import { useScreenDetection } from '@/composable/screenDetection';

const modal = ref();
const { isActive, calculationResult } = usePumpCalculation();
const { isMobile } = useScreenDetection();

const initialBreakpoint = 0.4;

useIonModalBreakpoint(modal, initialBreakpoint);
</script>

<template>
	<template v-if="isMobile">
		<ion-modal
			ref="modal"
			:is-open="isActive"
			:breakpoints="[0.25, 0.4, 0.5, 0.75]"
			:initial-breakpoint="initialBreakpoint"
			:backdrop-dismiss="false"
			:backdrop-opacity="0"
			:showBackdrop="false"
			:expand-to-scroll="false"
			handle-behavior="cycle"
			class="supply-pipe"
		>
			<SupplyPipeCalculationHeader></SupplyPipeCalculationHeader>
			<ion-content>
				<SupplyPipeCalculation></SupplyPipeCalculation>
			</ion-content>
		</ion-modal>
	</template>
	<ion-card v-else-if="isActive" class="desktop-card">
		<SupplyPipeCalculationHeader></SupplyPipeCalculationHeader>
		<SupplyPipeCalculation></SupplyPipeCalculation>
	</ion-card>

	<ion-icon
		v-if="isActive && !calculationResult"
		:icon="locateOutline"
		class="center-locate"
		size="medium"
	/>
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

.center-locate {
	position: fixed;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	font-size: 48px;
	z-index: 1200;
	color: var(--ion-color-primary, #3880ff);
	pointer-events: none;
}

@media (max-width: 767px) {
	.supply-pipe::part(content) {
		border-radius: 8px 8px 0 0;
		box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.1);
	}
}
</style>
