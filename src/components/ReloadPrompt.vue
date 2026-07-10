<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-unused-vars -- the pug template below isn't parsed by
   vue-eslint-parser, so its references to these vars look unused. Pre-existing, unused
   component (superseded by UpdateToast.vue); left as-is. */
import { useRegisterSW } from 'virtual:pwa-register/vue';

const { offlineReady, needRefresh, updateServiceWorker } = useRegisterSW();

async function close() {
	offlineReady.value = false;
	needRefresh.value = false;
}

const text = `New content available, click on reload button to update.`;
</script>

<template lang="pug">
.text-center.ma-2
v-snackbar(v-model='needRefresh')
	| {{ text }}
	template(v-slot:actions='')
		v-btn(
			v-if='needRefresh',
			color='primary',
			rounded,
			variant='elevated',
			@click='updateServiceWorker()'
		)
			| Reload
		v-btn(rounded, variant='text', @click='close')
			| Close
</template>
