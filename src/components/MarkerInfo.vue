<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { watch } from 'vue';
import { ref } from 'vue';
import {
	IonModal,
	IonContent,
	IonCard,
	IonCardHeader,
	IonCardContent,
	IonCardTitle
} from '@ionic/vue';

const router = useRouter();
const route = useRoute();

let showMarkerInfo = ref(false);
// fetch the user information when params change
watch(
	() => route.params.markerId,
	async (newId) => {
		console.log('MARKER', newId);
		showMarkerInfo.value = !!newId;
	}
);

// const { mobile } = useDisplay();
let sheetWidth = ref('100%');
let sheetHeight = ref('100%');

watch(
	() => true, //mobile.value,
	async (isMobile) => {
		console.log('MODDSFS', isMobile);
		if (isMobile) {
			sheetWidth.value = '100%';
			sheetHeight.value = '100%';
		} else {
			sheetWidth.value = '30%';
		}
	},
	{ immediate: true }
);
</script>

<template>
	<ion-modal
		:is-open="showMarkerInfo"
		:breakpoints="[0, 0.5, 1]"
		:initial-breakpoint="1"
		@didDismiss="router.push('/')"
	>
		<ion-content>
			<ion-card>
				<ion-card-header>
					<ion-card-title>Bottom Sheet</ion-card-title>
				</ion-card-header>
				<ion-card-content>
					Lorem ipsum dolor sit amet consectetur, adipisicing elit. Ut, eos? Nulla aspernatur odio
					rem, culpa voluptatibus eius debitis dolorem perspiciatis asperiores sed consectetur
					praesentium! Delectus et iure maxime eaque exercitationem!
				</ion-card-content>
			</ion-card>
		</ion-content>
	</ion-modal>
</template>
