<script setup lang="ts">
import {
	IonButton,
	IonCard,
	IonCardContent,
	IonCardHeader,
	IonCardTitle,
	IonIcon
} from '@ionic/vue';
import { close } from 'ionicons/icons';
import { onMounted, watch } from 'vue';
import { getMapNodeById } from '@/mapHandler/databaseHandler';

const emit = defineEmits<{
	(e: 'close'): void;
}>();

const props = defineProps<{ markerId: number }>();

onMounted(async () => {
	watch(
		() => props.markerId,
		async (newId) => {
			if (newId) {
				const info = await getMapNodeById(props.markerId);
				console.log('Marker ID changed:', newId, info);
			}
		},
		{ immediate: true }
	);
});

const closeModal = () => {
	emit('close');
};
</script>

<template>
	<ion-card>
		<ion-card-header>
			<div class="header-content">
				<ion-card-title>Location Info</ion-card-title>
				<ion-button fill="clear" @click="closeModal">
					<ion-icon :icon="close" />
				</ion-button>
			</div>
		</ion-card-header>
		<ion-card-content>
			Lorem ipsum dolor sit amet consectetur, adipisicing elit. Ut, eos? Nulla aspernatur odio rem,
			culpa voluptatibus eius debitis dolorem perspiciatis asperiores sed consectetur praesentium!
			Delectus et iure maxime eaque exercitationem!
		</ion-card-content>
	</ion-card>
</template>

<style scoped>
.header-content {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px;
}
</style>
