import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'at.jst.fireyak',
	appName: 'FireYak',
	webDir: 'dist',
	android: {
		adjustMarginsForEdgeToEdge: 'disable'
	},
	ios: {
		// Enable edge-to-edge display with safe area handling
		contentInset: 'automatic'
	},
	plugins: {
		CapacitorHttp: {
			enabled: false
		}
	}
};

export default config;
