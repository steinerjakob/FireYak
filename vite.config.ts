// Plugins
import vue from '@vitejs/plugin-vue';
import ViteFonts from 'unplugin-fonts/vite';
import { VitePWA, VitePWAOptions } from 'vite-plugin-pwa';

// Utilities
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const purpose = 'any maskable';

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
				src: 'icons/icon-48.webp',
				type: 'image/png',
				sizes: '48x48',
				purpose
			},
			{
				src: 'icons/icon-72.webp',
				type: 'image/png',
				sizes: '72x72',
				purpose
			},
			{
				src: 'icons/icon-96.webp',
				type: 'image/png',
				sizes: '96x96',
				purpose
			},
			{
				src: 'icons/icon-128.webp',
				type: 'image/png',
				sizes: '128x128',
				purpose
			},
			{
				src: 'icons/icon-192.webp',
				type: 'image/png',
				sizes: '192x192',
				purpose
			},
			{
				src: 'icons/icon-256.webp',
				type: 'image/png',
				sizes: '256x256',
				purpose
			},
			{
				src: 'icons/icon-512.webp',
				type: 'image/png',
				sizes: '512x512',
				purpose
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
	},
	workbox: {
		runtimeCaching: [
			{
				urlPattern: /^https?:\/\/tile\.openstreetmap\.org\/.*/,
				handler: 'StaleWhileRevalidate',
				options: {
					cacheName: 'osm-tiles-cache',
					expiration: {
						maxEntries: 500,
						maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
					},
					cacheableResponse: {
						statuses: [0, 200]
					}
				}
			}
		]
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
	}
});
