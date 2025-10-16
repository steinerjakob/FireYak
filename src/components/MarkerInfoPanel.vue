<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { computed, ref, watch } from 'vue';
import { IonContent, IonCard, IonModal } from '@ionic/vue';
import MarkerInfo from '@/components/MarkerInfo.vue';
import MarkerInfoHeader from '@/components/MarkerInfoHeader.vue';

const router = useRouter();
const route = useRoute();
const modal = ref();

const showMarkerInfo = computed(() => !!route.params.markerId);
const markerId = computed(() => Number(route.params.markerId));

const isMobile = ref(window.innerWidth < 768);

watch(showMarkerInfo, () => {
	isMobile.value = window.innerWidth < 768;
});

const closeModal = () => {
	router.push('/');
};
</script>

<template>
	<template v-if="isMobile">
		<ion-modal
			ref="modal"
			:is-open="showMarkerInfo"
			:breakpoints="[0.25, 0.4, 0.5, 0.75]"
			:initial-breakpoint="0.4"
			:backdrop-dismiss="false"
			:backdrop-opacity="0"
			:showBackdrop="false"
			:expand-to-scroll="false"
			handle-behavior="cycle"
			class="marker-info"
		>
			<MarkerInfoHeader></MarkerInfoHeader>
			<ion-content>
				<MarkerInfo @close="closeModal"></MarkerInfo>
			</ion-content>
		</ion-modal>
	</template>
	<ion-card v-else-if="showMarkerInfo" class="desktop-card">
		<MarkerInfoHeader></MarkerInfoHeader>
		<MarkerInfo @close="closeModal"></MarkerInfo>
	</ion-card>
</template>

<style scoped>
.marker-info {
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
	.marker-info::part(content) {
		border-radius: 8px 8px 0 0;
		box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.1);
	}
}
</style>
