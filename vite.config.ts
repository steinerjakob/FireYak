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

/**
 * Extra label shown next to the version on the About screen for non-release
 * builds, so testers can tell which commit they are running. Empty for
 * releases (the label is hidden).
 * - `APP_BUILD_LABEL`: set by the main-branch dev builds (dev-builds.yml), e.g. `dev.efc03e6`
 * - Cloudflare Pages: `<branch>.<sha7>` from the built-in `CF_PAGES_*` build variables
 */
function getBuildLabel(): string {
	if (process.env.APP_BUILD_LABEL) return process.env.APP_BUILD_LABEL;
	const sha = process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7);
	if (process.env.CF_PAGES === '1' && sha) {
		const branch = process.env.CF_PAGES_BRANCH;
		return branch ? `${branch}.${sha}` : sha;
	}
	return '';
}

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
					globIgnores: ['**/land.html'],
					navigateFallbackDenylist: [/^\/land\.html/],
					// The main chunk grew past workbox's 2 MiB default with the offline
					// feature; the app shell must stay precached or the PWA won't start
					// without connectivity.
					maximumFileSizeToCacheInBytes: 3 * 1024 * 1024
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
				urlPattern: /^https?:\/\/commons\.wikimedia\.org\/w\/api\.php\?.*/,
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
			},
			{
				// Panoramax serves picture bytes under the picture id
				// (`…/pictures/<uuid>/hd.jpg`). They are immutable, so cache them
				// outright — this rule must precede the metadata rule below, which
				// would otherwise re-download every photo in the background.
				urlPattern: /^https:\/\/api\.panoramax\.xyz\/api\/pictures\/[^/]+\/.+/,
				handler: 'CacheFirst',
				options: {
					cacheName: 'panoramax-images-cache',
					expiration: {
						maxEntries: 200,
						maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
					},
					cacheableResponse: {
						statuses: [0, 200]
					}
				}
			},
			{
				urlPattern: /^https:\/\/api\.panoramax\.xyz\/api\/pictures\/[^/]+$/,
				handler: 'StaleWhileRevalidate',
				options: {
					cacheName: 'panoramax-api-cache',
					expiration: {
						maxEntries: 100,
						maxAgeSeconds: 7 * 24 * 60 * 60 // 7 days
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
		__BUILD_TARGET_NATIVE__: JSON.stringify(isNativeBuild),
		__APP_BUILD_LABEL__: JSON.stringify(getBuildLabel())
	},
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url))
		},
		extensions: ['.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue']
	}
});
