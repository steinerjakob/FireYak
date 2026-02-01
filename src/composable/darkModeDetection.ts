import { ref, watch } from 'vue';
import { useSettingsStore } from '@/store/settingsStore';
import { storeToRefs } from 'pinia';

// This composable should be a singleton, so we define the state outside the function.
const isDarkMode = ref(false);
let mediaQuery: MediaQueryList | null = null;
let listener: ((e: MediaQueryListEvent) => void) | null = null;

export function useDarkMode() {
	const settingsStore = useSettingsStore();
	const { theme } = storeToRefs(settingsStore);

	const applyTheme = () => {
		// Clean up previous listener if it exists
		if (mediaQuery && listener) {
			mediaQuery.removeEventListener('change', listener);
			listener = null;
		}

		if (theme.value === 'dark') {
			isDarkMode.value = true;
		} else if (theme.value === 'light') {
			isDarkMode.value = false;
		} else {
			// 'auto' mode
			mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
			isDarkMode.value = mediaQuery.matches;
			listener = (e: MediaQueryListEvent) => {
				isDarkMode.value = e.matches;
			};
			mediaQuery.addEventListener('change', listener);
		}
		document.body.classList.toggle('dark', isDarkMode.value);
	};

	// Watch for changes in the theme setting and apply it
	watch(theme, applyTheme, { immediate: true });

	return { isDarkMode };
}
