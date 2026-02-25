import { useSettingsStore, type ThemeSetting } from '@/store/settingsStore';
import { Preferences } from '@capacitor/preferences';

const THEME_KEY = 'theme';
const SHOW_ZOOM_BUTTONS_KEY = 'show_zoom_buttons';

export function useSettings() {
	const settingsStore = useSettingsStore();

	/**
	 * Loads settings from persistent storage and updates the store.
	 * Also initializes the theme system to apply the correct theme on startup.
	 */
	const loadSettings = async () => {
		const [themeResult, showZoomButtonsResult] = await Promise.all([
			Preferences.get({ key: THEME_KEY }),
			Preferences.get({ key: SHOW_ZOOM_BUTTONS_KEY })
		]);

		if (themeResult.value) {
			settingsStore.setTheme(themeResult.value as ThemeSetting);
		}

		if (showZoomButtonsResult.value) {
			settingsStore.setShowZoomButtons(showZoomButtonsResult.value === 'true');
		}

		// Initialize the theme system after loading settings
		// This ensures the theme is applied on app startup and listeners are set up
		settingsStore.initializeTheme();
	};

	/**
	 * Saves the theme setting to persistent storage and updates the store.
	 * @param theme The theme to save.
	 */
	const saveTheme = async (theme: ThemeSetting) => {
		settingsStore.setTheme(theme);
		await Preferences.set({
			key: THEME_KEY,
			value: theme
		});
	};

	/**
	 * Saves the zoom button visibility setting to persistent storage and updates the store.
	 * @param show The visibility state to save.
	 */
	const saveShowZoomButtons = async (show: boolean) => {
		settingsStore.setShowZoomButtons(show);
		await Preferences.set({
			key: SHOW_ZOOM_BUTTONS_KEY,
			value: String(show)
		});
	};

	return {
		loadSettings,
		saveTheme,
		saveShowZoomButtons
	};
}
