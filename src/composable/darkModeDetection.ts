import { computed, type ComputedRef } from 'vue';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * Reactive "is the dark palette active" flag for consumers that have to restyle
 * themselves in JS (the map flavors, mainly).
 *
 * This is a read-only view of the settings store, which owns both the theme
 * setting and the system-preference listener and is the only place that touches
 * the palette classes on `<html>`. Detecting and applying the theme a second
 * time here used to let the two copies drift apart: the map followed a system
 * switch while the document classes did not.
 */
export function useDarkMode(): { isDarkMode: ComputedRef<boolean> } {
	const settingsStore = useSettingsStore();

	return { isDarkMode: computed(() => settingsStore.isDarkMode) };
}
