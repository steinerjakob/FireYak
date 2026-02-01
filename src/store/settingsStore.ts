import { defineStore } from 'pinia';

export type ThemeSetting = 'light' | 'dark' | 'auto';

export const useSettingsStore = defineStore('settings', {
	state: () => ({
		theme: 'auto' as ThemeSetting,
		showZoomButtons: true
	}),
	actions: {
		setTheme(theme: ThemeSetting) {
			this.theme = theme;
		},
		setShowZoomButtons(show: boolean) {
			this.showZoomButtons = show;
		}
	}
});
