import { computed } from 'vue';
import { useRoute } from 'vue-router';

export function usePumpCalculation() {
	const route = useRoute();

	const isActive = computed(() => route.path.includes('supplyPipe'));

	return { isActive };
}
