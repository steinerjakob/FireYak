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

const emit = defineEmits<{
	(e: 'close'): void;
}>();

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
