import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'at.jst.fireyak',
	appName: 'FireYak',
	webDir: 'dist',
	android: {},
	plugins: {
		StausBar: {
			overlaysWebView: true },
		SystemBars: {
			insetsHandling: 'disable'
		},
		CapacitorHttp: {
			enabled: false
		}
	}
};

export default config;
