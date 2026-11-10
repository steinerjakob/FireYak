import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { Preferences } from '@capacitor/preferences';
import type maplibregl from 'maplibre-gl';
import { DEFAULT_MAX_HOSE_PRESSURE_BAR, parseStoredMaxHosePressure } from '@/helper/hosePressure';

const STORAGE_KEYS = {
	TUBE_LENGTH: 'pumpCalc_tubeLength',
	INPUT_PRESSURE: 'pumpCalc_inputPressure',
	OUTPUT_PRESSURE: 'pumpCalc_outputPressure',
	PRESSURE_LOST: 'pumpCalc_pressureLost',
	TARGET_PRESSURE: 'pumpCalc_targetPressure',
	TUBE_DIAMETER: 'pumpCalc_tubeDiameter',
	HOSE_NAME: 'pumpCalc_hoseName',
	MAX_HOSE_PRESSURE: 'pumpCalc_maxHosePressure'
};

export const usePumpCalculationStore = defineStore('pumpCalculation', () => {
	const tubeLength = ref(20); // in meters
	const inputPressure = ref(1.5); // bar (min. Eingangsdruck at every booster pump)
	// Planning value per doctrine: relay stretches assume p_a = 8 bar
	// (10 bar is the DIN EN 1028 nominal maximum, not the planning value).
	const outputPressure = ref(8); // bar
	const pressureLost = ref(1.0); // bar per 100 m B-hose at 800 l/min (HLFS Tab. 2)
	// Required pressure at the fire object (Strahlrohrdruck, ~5 bar for a
	// Mehrzweckstrahlrohr) — the last stretch must end with this, not just
	// the pump input pressure.
	const targetPressure = ref(5); // bar
	// Hose type: European B-hose by default (75 mm). The diameter is
	// informational for now — friction loss is set via the flow-rate value.
	const tubeDiameter = ref(75); // mm
	const hoseName = ref('B'); // short designation used in all "B-hoses" texts
	// Maximum working pressure of the hoses (DIN 14811 pressure hoses: 16 bar);
	// long downhill lines warn when the static pressure could reach it.
	const maxHosePressure = ref(DEFAULT_MAX_HOSE_PRESSURE_BAR); // bar

	const suctionPoint = ref<maplibregl.Marker | null>(null);
	const targetPoint = ref<maplibregl.Marker | null>(null);

	// Load settings from preferences on store initialization
	const loadSettings = async () => {
		try {
			const [
				tubeLengthResult,
				inputPressureResult,
				outputPressureResult,
				pressureLostResult,
				targetPressureResult,
				tubeDiameterResult,
				hoseNameResult,
				maxHosePressureResult
			] = await Promise.all([
				Preferences.get({ key: STORAGE_KEYS.TUBE_LENGTH }),
				Preferences.get({ key: STORAGE_KEYS.INPUT_PRESSURE }),
				Preferences.get({ key: STORAGE_KEYS.OUTPUT_PRESSURE }),
				Preferences.get({ key: STORAGE_KEYS.PRESSURE_LOST }),
				Preferences.get({ key: STORAGE_KEYS.TARGET_PRESSURE }),
				Preferences.get({ key: STORAGE_KEYS.TUBE_DIAMETER }),
				Preferences.get({ key: STORAGE_KEYS.HOSE_NAME }),
				Preferences.get({ key: STORAGE_KEYS.MAX_HOSE_PRESSURE })
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
			if (targetPressureResult.value) {
				targetPressure.value = parseFloat(targetPressureResult.value);
			}
			if (tubeDiameterResult.value) {
				tubeDiameter.value = parseFloat(tubeDiameterResult.value);
			}
			if (hoseNameResult.value) {
				hoseName.value = hoseNameResult.value;
			}
			// Installs from before the setting existed have no value: the default applies.
			maxHosePressure.value = parseStoredMaxHosePressure(maxHosePressureResult.value);
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
				Preferences.set({ key: STORAGE_KEYS.PRESSURE_LOST, value: pressureLost.value.toString() }),
				Preferences.set({
					key: STORAGE_KEYS.TARGET_PRESSURE,
					value: targetPressure.value.toString()
				}),
				Preferences.set({
					key: STORAGE_KEYS.TUBE_DIAMETER,
					value: tubeDiameter.value.toString()
				}),
				Preferences.set({ key: STORAGE_KEYS.HOSE_NAME, value: hoseName.value }),
				Preferences.set({
					key: STORAGE_KEYS.MAX_HOSE_PRESSURE,
					value: maxHosePressure.value.toString()
				})
			]);
		} catch (error) {
			console.error('Failed to save settings to preferences:', error);
		}
	};

	// Watch for changes and save automatically
	watch(
		[
			tubeLength,
			inputPressure,
			outputPressure,
			pressureLost,
			targetPressure,
			tubeDiameter,
			hoseName,
			maxHosePressure
		],
		() => {
			saveSettings();
		}
	);

	// Load settings when store is created
	loadSettings();

	return {
		// State
		tubeLength,
		inputPressure,
		outputPressure,
		pressureLost,
		targetPressure,
		tubeDiameter,
		hoseName,
		maxHosePressure,
		suctionPoint,
		targetPoint,
		// Methods
		loadSettings,
		saveSettings
	};
});
