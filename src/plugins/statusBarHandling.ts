import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

// Define your preferred colors for light and dark mode
const LIGHT_MODE_COLOR = '#ffffff';
const DARK_MODE_COLOR = '#121212';

function getThemeStatusBarColor(isDark: boolean) {
	return isDark ? DARK_MODE_COLOR : LIGHT_MODE_COLOR;
}

async function setAndroidStatusBarColor(isDark: boolean) {
	const color = getThemeStatusBarColor(isDark);
	try {
		await EdgeToEdge.setBackgroundColor({ color });
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

async function initializeEdgeToEdge() {
	if (Capacitor.getPlatform() === 'android') {
		try {
			await EdgeToEdge.enable();

			// Set initial status bar color
			updateStatusBarColor();
		} catch (e) {
			console.error('Failed to configure Android Edge to Edge support: ', e);
		}
	}
}

// Listen for theme changes
mediaQuery.addEventListener('change', updateStatusBarColor);

// Listen for app state changes (when app resumes from background)
App.addListener('resume', () => {
	initializeEdgeToEdge();
});

// Initial setup on app load
initializeEdgeToEdge();
