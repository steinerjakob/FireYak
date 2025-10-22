import { defineStore } from 'pinia';
import { ref } from 'vue';

export const usePumpCalculationStore = defineStore('pumpCalculation', () => {
	const tubeLength = ref(20); // in meters
	const inputPressure = ref(1.5); // bar
	const outputPressure = ref(10); // bar
	const pressureLost = ref(1.1); // bar per meter for 800l/min

	return {
		// State
		tubeLength,
		inputPressure,
		outputPressure,
		pressureLost
	};
});
