// Plugins
import vue from '@vitejs/plugin-vue';
import ViteFonts from 'unplugin-fonts/vite';
import { VitePWA, VitePWAOptions } from 'vite-plugin-pwa';

// Utilities
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const pwaOptions: Partial<VitePWAOptions> = {
	mode: 'production',
	base: '/',
	includeAssets: ['favicon.svg'],
	manifest: {
		name: 'FireYak',
		short_name: 'FireYak',
		display: 'standalone',
		icons: [
			{
				src: 'icons/icon-72x72.png',
				sizes: '72x72',
				type: 'image/png'
			},
			{
				src: 'icons/icon-96x96.png',
				sizes: '96x96',
				type: 'image/png'
			},
			{
				src: 'icons/icon-128x128.png',
				sizes: '128x128',
				type: 'image/png'
			},
			{
				src: 'icons/icon-144x144.png',
				sizes: '144x144',
				type: 'image/png'
			},
			{
				src: 'icons/icon-152x152.png',
				sizes: '152x152',
				type: 'image/png'
			},
			{
				src: 'icons/icon-192x192.png',
				sizes: '192x192',
				type: 'image/png'
			},
			{
				src: 'icons/icon-384x384.png',
				sizes: '384x384',
				type: 'image/png'
			},
			{
				src: 'icons/icon-512x512.png',
				sizes: '512x512',
				type: 'image/png'
			}
		]
	},
	registerType: 'prompt',
	devOptions: {
		enabled: false,
		/* when using generateSW the PWA plugin will switch to classic */
		type: 'module',
		navigateFallback: 'index.html',
		suppressWarnings: true
	}
};

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		vue(),

		ViteFonts({
			google: {
				families: [
					{
						name: 'Roboto',
						styles: 'wght@100;300;400;500;700;900'
					}
				]
			}
		}),
		VitePWA(pwaOptions)
	],
	define: { 'process.env': {} },
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url))
		},
		extensions: ['.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue']
	},
	server: {
		port: 3000
	}
});
