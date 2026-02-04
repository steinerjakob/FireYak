import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { SafeArea } from '@capacitor-community/safe-area';

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

export async function updateEdge2Edge() {
	const platform = Capacitor.getPlatform();
	const isDark = mediaQuery.matches;

	if (platform === 'android') {
		try {
			await SafeArea.enable({
				config: {
					customColorsForSystemBars: true,
					statusBarColor: '#00ffffff', // transparent
					statusBarContent: isDark ? 'light' : 'dark',
					navigationBarColor: '#00ffffff', // transparent
					navigationBarContent: isDark ? 'light' : 'dark'
				}
			});
		} catch (e) {
			console.error(e);
		}
	} else if (platform === 'ios') {
		// On iOS, enable SafeArea plugin to inject CSS variables for safe-area-inset-*
		// This makes --safe-area-inset-top, --safe-area-inset-bottom, etc. available
		try {
			await SafeArea.enable({
				config: {
					customColorsForSystemBars: false,
					statusBarContent: isDark ? 'light' : 'dark'
				}
			});
		} catch (e) {
			console.error(e);
		}
	}
}

// Listen for theme changes
mediaQuery.addEventListener('change', updateEdge2Edge);

// Listen for app state changes (when app resumes from background)
App.addListener('resume', () => {
	updateEdge2Edge()
});
