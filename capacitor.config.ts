import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'at.jst.fireyak',
	appName: 'FireYak',
	webDir: 'dist',
	android: {
		adjustMarginsForEdgeToEdge: 'disable'
	}
};

export default config;
