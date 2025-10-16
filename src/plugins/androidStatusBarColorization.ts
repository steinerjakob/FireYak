import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';

// Define your preferred colors for light and dark mode
const LIGHT_MODE_COLOR = '#ffffff';
const DARK_MODE_COLOR = '#121212';

function getThemeStatusBarColor(isDark: boolean) {
	return isDark ? DARK_MODE_COLOR : LIGHT_MODE_COLOR;
}

async function setAndroidStatusBarColor(isDark: boolean) {
	const color = getThemeStatusBarColor(isDark);
	try {
		await EdgeToEdge.disable();
		await EdgeToEdge.setBackgroundColor({ color });
		await StatusBar.setOverlaysWebView({ overlay: true });
	} catch (e) {
		console.error('Failed to set Android status bar color: ', e);
	}
}

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function updateStatusBarColor() {
	if (Capacitor.getPlatform() === 'android') {
		setAndroidStatusBarColor(mediaQuery.matches);
	}
}

// Listen for theme changes
mediaQuery.addEventListener('change', updateStatusBarColor);

// Initial call on app load
updateStatusBarColor();
