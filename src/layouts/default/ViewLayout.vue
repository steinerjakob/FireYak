<template>
	<v-main>
		<router-view />
		<ReloadPrompt></ReloadPrompt>
	</v-main>
</template>

<script lang="ts" setup>
import ReloadPrompt from '@/components/ReloadPrompt.vue';
</script>
