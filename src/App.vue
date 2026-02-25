<template>
	<ion-app>
		<ion-router-outlet />
		<UpdateToast></UpdateToast>
	</ion-app>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import UpdateToast from '@/components/UpdateToast.vue';
import { useSettings } from '@/composable/settings';
import { useOsmAuthStore } from '@/store/osmAuthStore';

// Load user settings from storage on app startup
const { loadSettings } = useSettings();
loadSettings();

const osmAuthStore = useOsmAuthStore();
onMounted(() => osmAuthStore.loadToken());
</script>
