import { defineStore } from 'pinia';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';

export type ThemeSetting = 'light' | 'dark' | 'auto';
export type MapLayerSetting = 'standard' | 'satellite';

// Media query for detecting system dark mode preference
const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Applies the appropriate theme class to the document based on the setting.
 * @param theme The theme setting ('light', 'dark', or 'auto')
 */
const applyThemeToDocument = (theme: ThemeSetting) => {
	const isDark = theme === 'dark' || (theme === 'auto' && darkModeMediaQuery.matches);

	// Toggle Ionic's dark palette class
	document.documentElement.classList.toggle('ion-palette-dark', isDark);

	if (Capacitor.isNativePlatform()) {
		SystemBars.setStyle({ style: isDark ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
	}
};

export const useSettingsStore = defineStore('settings', {
	state: () => ({
		theme: 'auto' as ThemeSetting,
		showZoomButtons: true,
		mapLayer: 'standard' as MapLayerSetting,
		terrain3d: false,
		osmAuthToken: '',
		_darkModeListener: null as ((e: MediaQueryListEvent) => void) | null
	}),
	actions: {
		setTheme(theme: ThemeSetting) {
			this.theme = theme;
			this._setupDarkModeListener();
			applyThemeToDocument(theme);
		},
		setShowZoomButtons(show: boolean) {
			this.showZoomButtons = show;
		},
		setMapLayer(mapLayer: MapLayerSetting) {
			this.mapLayer = mapLayer;
		},
		setTerrain3d(enabled: boolean) {
			this.terrain3d = enabled;
		},
		setOsmAuthToken(token: string) {
			this.osmAuthToken = token;
		},
		/**
		 * Sets up or removes the system dark mode listener based on the current theme setting.
		 * When theme is 'auto', listens for system changes. Otherwise, removes the listener.
		 */
		_setupDarkModeListener() {
			// Remove existing listener if any
			if (this._darkModeListener) {
				darkModeMediaQuery.removeEventListener('change', this._darkModeListener);
				this._darkModeListener = null;
			}

			// Only add listener when theme is set to 'auto'
			if (this.theme === 'auto') {
				this._darkModeListener = () => {
					applyThemeToDocument(this.theme);
				};
				darkModeMediaQuery.addEventListener('change', this._darkModeListener);
			}
		},
		/**
		 * Initializes the theme system. Should be called when the app starts.
		 */
		initializeTheme() {
			this._setupDarkModeListener();
			applyThemeToDocument(this.theme);
		}
	}
});
