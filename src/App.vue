<template>
	<ion-app>
		<ion-router-outlet />
		<UpdateToast></UpdateToast>
	</ion-app>
</template>

<script setup lang="ts">
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import UpdateToast from '@/components/UpdateToast.vue';
</script>
