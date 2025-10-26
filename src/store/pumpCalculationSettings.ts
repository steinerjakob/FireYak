import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { Preferences } from '@capacitor/preferences';
import L from 'leaflet';

const STORAGE_KEYS = {
	TUBE_LENGTH: 'pumpCalc_tubeLength',
	INPUT_PRESSURE: 'pumpCalc_inputPressure',
	OUTPUT_PRESSURE: 'pumpCalc_outputPressure',
	PRESSURE_LOST: 'pumpCalc_pressureLost'
};

export const usePumpCalculationStore = defineStore('pumpCalculation', () => {
	const tubeLength = ref(20); // in meters
	const inputPressure = ref(1.5); // bar
	const outputPressure = ref(10); // bar
	const pressureLost = ref(1.1); // bar per meter for 800l/min

	const suctionPoint = ref<L.Marker | null>(null);
	const targetPoint = ref<L.Marker | null>(null);

	// Load settings from preferences on store initialization
	const loadSettings = async () => {
		try {
			const [tubeLengthResult, inputPressureResult, outputPressureResult, pressureLostResult] =
				await Promise.all([
					Preferences.get({ key: STORAGE_KEYS.TUBE_LENGTH }),
					Preferences.get({ key: STORAGE_KEYS.INPUT_PRESSURE }),
					Preferences.get({ key: STORAGE_KEYS.OUTPUT_PRESSURE }),
					Preferences.get({ key: STORAGE_KEYS.PRESSURE_LOST })
				]);

			if (tubeLengthResult.value) {
				tubeLength.value = parseFloat(tubeLengthResult.value);
			}
			if (inputPressureResult.value) {
				inputPressure.value = parseFloat(inputPressureResult.value);
			}
			if (outputPressureResult.value) {
				outputPressure.value = parseFloat(outputPressureResult.value);
			}
			if (pressureLostResult.value) {
				pressureLost.value = parseFloat(pressureLostResult.value);
			}
		} catch (error) {
			console.error('Failed to load settings from preferences:', error);
		}
	};

	// Save settings to preferences
	const saveSettings = async () => {
		try {
			await Promise.all([
				Preferences.set({ key: STORAGE_KEYS.TUBE_LENGTH, value: tubeLength.value.toString() }),
				Preferences.set({
					key: STORAGE_KEYS.INPUT_PRESSURE,
					value: inputPressure.value.toString()
				}),
				Preferences.set({
					key: STORAGE_KEYS.OUTPUT_PRESSURE,
					value: outputPressure.value.toString()
				}),
				Preferences.set({ key: STORAGE_KEYS.PRESSURE_LOST, value: pressureLost.value.toString() })
			]);
		} catch (error) {
			console.error('Failed to save settings to preferences:', error);
		}
	};

	// Watch for changes and save automatically
	watch([tubeLength, inputPressure, outputPressure, pressureLost], () => {
		saveSettings();
	});

	// Load settings when store is created
	loadSettings();

	return {
		// State
		tubeLength,
		inputPressure,
		outputPressure,
		pressureLost,
		suctionPoint,
		targetPoint,
		// Methods
		loadSettings,
		saveSettings
	};
});
