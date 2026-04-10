// Plugins
import vue from '@vitejs/plugin-vue';
import ViteFonts from 'unplugin-fonts/vite';
import { VitePWA, VitePWAOptions } from 'vite-plugin-pwa';

// Utilities
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Check if building for native platforms (Android/iOS)
const isNativeBuild = process.env.BUILD_TARGET === 'native';

const purpose = 'any maskable';

// PWA options - for native builds, the service worker only handles runtime
// caching (map tiles) with no precaching or navigation fallback.
// For web builds, full PWA behavior is enabled.
const pwaOptions: Partial<VitePWAOptions> = {
	mode: 'production',
	base: '/',
	includeAssets: isNativeBuild ? [] : ['favicon.svg'],
	registerType: isNativeBuild ? 'autoUpdate' : 'prompt',
	// Disable manifest for native builds
	manifest: isNativeBuild
		? false
		: {
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
	devOptions: {
		enabled: false,
		/* when using generateSW the PWA plugin will switch to classic */
		type: 'module',
		navigateFallback: 'index.html',
		suppressWarnings: true
	},
	workbox: {
		// Native: no precaching, no navigation fallback — only runtime caching for tiles
		// Web: full precaching with navigateFallback support
		...(isNativeBuild
			? { globPatterns: [] }
			: {
					globIgnores: ['**/land.html', '**/wikimedia-callback/**'],
					navigateFallbackDenylist: [/^\/land\.html/, /^\/wikimedia-callback/]
				}),
		runtimeCaching: [
			{
				urlPattern: /^https?:\/\/api\.protomaps\.com\/.*/,
				handler: 'StaleWhileRevalidate',
				options: {
					cacheName: 'protomaps-cache',
					expiration: {
						maxEntries: 500,
						maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
					},
					cacheableResponse: {
						statuses: [0, 200]
					}
				}
			},
			{
				urlPattern:
					/^https?:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/.*/,
				handler: 'StaleWhileRevalidate',
				options: {
					cacheName: 'arcgis-tiles-cache',
					expiration: {
						maxEntries: 500,
						maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
					},
					cacheableResponse: {
						statuses: [0, 200]
					}
				}
			},
			{
				urlPattern: /^https?:\/\/tiles\.mapterhorn\.com\/.*/,
				handler: 'CacheFirst',
				options: {
					cacheName: 'mapterhorn-tiles-cache',
					expiration: {
						maxEntries: 500,
						maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
					},
					cacheableResponse: {
						statuses: [0, 200]
					}
				}
			},
			{
				urlPattern:
					/^https?:\/\/commons\.wikimedia\.(org|beta\.wmflabs\.org)\/w\/api\.php\?action=query.*/,
				handler: 'StaleWhileRevalidate',
				options: {
					cacheName: 'wikimedia-api-cache',
					expiration: {
						maxEntries: 100,
						maxAgeSeconds: 7 * 24 * 60 * 60 // 7 days
					},
					cacheableResponse: {
						statuses: [0, 200]
					}
				}
			},
			{
				urlPattern: /^https?:\/\/upload\.wikimedia\.org\/.*/,
				handler: 'CacheFirst',
				options: {
					cacheName: 'wikimedia-images-cache',
					expiration: {
						maxEntries: 200,
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
		// Always include VitePWA plugin - for native builds the SW only handles
		// runtime caching (map tiles) with no precaching or navigation fallback
		VitePWA(pwaOptions)
	],
	define: {
		'process.env': {},
		// Expose build target to client code for conditional service worker handling
		__BUILD_TARGET_NATIVE__: JSON.stringify(isNativeBuild)
	},
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url))
		},
		extensions: ['.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue']
	}
});
