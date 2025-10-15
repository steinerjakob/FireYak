import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

export async function enableEdge2Edge() {
	if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
		await EdgeToEdge.enable();
	}
	await StatusBar.setStyle({ style: Style.Default });
	await StatusBar.setOverlaysWebView({ overlay: true });
}
