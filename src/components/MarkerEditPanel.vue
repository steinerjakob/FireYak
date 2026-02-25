<script setup lang="ts">
import { ref, watch } from 'vue';
import { IonContent, IonCard, IonModal } from '@ionic/vue';
import MarkerEdit from '@/components/MarkerEdit.vue';
import MarkerEditHeader from '@/components/MarkerEditHeader.vue';
import { useMarkerEditStore } from '@/store/markerEditStore';
import { useIonModalBreakpoint } from '@/composable/modalBreakpointWatcher';
import { useScreenDetection } from '@/composable/screenDetection';

const modal = ref<typeof IonModal>();
const markerEditStore = useMarkerEditStore();

const { isMobile } = useScreenDetection();

const initialBreakpoint = 0.5;

useIonModalBreakpoint(modal, initialBreakpoint);
</script>

<template>
	<template v-if="isMobile">
		<ion-modal
			ref="modal"
			:is-open="markerEditStore.isActive"
			:breakpoints="[0.25, 0.5, 0.9]"
			:initial-breakpoint="initialBreakpoint"
			:backdrop-dismiss="false"
			:backdrop-opacity="0"
			:showBackdrop="false"
			:expand-to-scroll="false"
			handle-behavior="cycle"
			class="marker-edit-modal"
		>
			<MarkerEditHeader></MarkerEditHeader>
			<ion-content>
				<MarkerEdit></MarkerEdit>
			</ion-content>
		</ion-modal>
	</template>
	<template v-else-if="markerEditStore.isActive">
		<ion-card class="desktop-card">
			<MarkerEditHeader class="sticky-header"></MarkerEditHeader>
			<div class="scrollable-content">
				<MarkerEdit></MarkerEdit>
			</div>
		</ion-card>
	</template>
</template>

<style scoped>
.marker-edit-modal {
	--height: 100%;
	--width: 100%;
	--backdrop-opacity: 0;
}

.marker-edit-modal::part(content) {
	position: relative;
	overflow: visible;
}

.desktop-card {
	position: fixed;
	left: 0;
	top: 0;
	bottom: 0;
	width: 400px;
	z-index: 1001;
	border-radius: 0;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	box-shadow: 4px 0 16px rgba(0, 0, 0, 0.1);
}

.desktop-card .sticky-header {
	flex-shrink: 0;
}

.desktop-card .scrollable-content {
	flex: 1;
	overflow-y: auto;
}

@media (max-width: 767px) {
	.marker-edit-modal::part(content) {
		border-radius: 8px 8px 0 0;
		box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.1);
	}
}
</style>
