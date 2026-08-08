import { computed, type ComputedRef } from 'vue';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * Reactive "is the dark palette active" flag, for consumers that restyle
 * themselves in JS (the map flavors, mainly). Read-only view of the settings
 * store, which owns detection and is the only place that touches the palette
 * classes on `<html>`.
 */
export function useDarkMode(): { isDarkMode: ComputedRef<boolean> } {
	const settingsStore = useSettingsStore();

	return { isDarkMode: computed(() => settingsStore.isDarkMode) };
}
