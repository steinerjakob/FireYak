// Plugins
import router from '@/router';
import { registerPlugins } from '@/plugins';
import { App as CapApp, URLOpenListenerEvent } from '@capacitor/app';

/* Core CSS required for Ionic components to work properly */
import '@ionic/vue/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/vue/css/normalize.css';
import '@ionic/vue/css/structure.css';
import '@ionic/vue/css/typography.css';

/* Optional CSS utils that can be commented out */
import '@ionic/vue/css/padding.css';
import '@ionic/vue/css/float-elements.css';
import '@ionic/vue/css/text-alignment.css';
import '@ionic/vue/css/text-transformation.css';
import '@ionic/vue/css/flex-utils.css';
import '@ionic/vue/css/display.css';

/**
 * Ionic Dark Mode
 * -----------------------------------------------------
 * For more info, please see:
 * https://ionicframework.com/docs/theming/dark-mode
 */
/* @import '@ionic/vue/css/palettes/dark.always.css'; */
/* @import '@ionic/vue/css/palettes/dark.class.css'; */
import '@ionic/vue/css/palettes/dark.class.css';

import '@/theme/variables.scss';
import '@/theme/md3/theme.css';

// Components
import App from './App.vue';

// Composables
import { createApp } from 'vue';
import { useOsmAuthStore, isNativeAuthInProgress } from '@/store/osmAuthStore';
import { isNativeWikimediaAuthInProgress } from '@/store/wikimediaAuthStore';
import { usePhotonSearch } from '@/composable/photonSearch';

const app = createApp(App);

registerPlugins(app);

router.isReady().then(async () => {
	app.mount('#app');
});

CapApp.addListener('appUrlOpen', async function (event: URLOpenListenerEvent) {
	const url = event.url;
	console.log('App opened with URL:', url);

	if (url.startsWith('geo:')) {
		handleGeoUrl(url);
		return;
	}

	// OAuth redirect callback.  On native, the InAppBrowser flow handles the
	// token exchange itself — the deep-link intent that arrives here is a
	// side-effect of the Android App Link and must be ignored to avoid a
	// destructive window.location.replace() that destroys the WebView state.
	if (url.includes('?code=')) {
		if (isNativeAuthInProgress()) {
			console.log('[OAuth/OSM] Ignoring appUrlOpen — InAppBrowser flow is active');
			return;
		}
		if (isNativeWikimediaAuthInProgress()) {
			console.log('[OAuth/Wikimedia] Ignoring appUrlOpen — InAppBrowser flow is active');
			return;
		}

		window.location.replace('/?' + url.split('?')[1]);
		const osmAuthStore = useOsmAuthStore();
		await osmAuthStore.loadToken();
		return router.push('/');
	}

	const parsedUrl = new URL(url);
	const hashPath = parsedUrl.hash.startsWith('#') ? parsedUrl.hash.slice(1) : '';

	if (!hashPath || hashPath === '/') {
		return router.push('/');
	}

	return router.push(hashPath);
});

/**
 * Parses query parameters from a geo URL part and extracts zoom and q (coordinates) values.
 * @param queryPart The query string part of the geo URL (e.g., "z=10&q=40.7128,-74.0060").
 * @returns An object containing parsed zoom, latitude, and longitude.
 */
const parseGeoQueryParams = (queryPart: string) => {
	const queryParams = new URLSearchParams(queryPart);
	let zoom = 15; // default zoom
	let latitude: number | undefined;
	let longitude: number | undefined;

	const zParam = queryParams.get('z');
	if (zParam) {
		zoom = parseFloat(zParam);
	}

	const qParam = queryParams.get('q');
	if (qParam) {
		const qCoords = qParam.split(',');
		if (qCoords.length >= 2) {
			const qLat = parseFloat(qCoords[0]);
			const qLng = parseFloat(qCoords[1]);
			if (!isNaN(qLat) && !isNaN(qLng)) {
				latitude = qLat;
				longitude = qLng;
			}
		}
	}
	return { zoom, latitude, longitude };
};

/**
 * Parses and handles the geo: URL
 * Example geo:40.7128,-74.0060?z=10 (latitude, longitude, optional zoom)
 * Also supports text queries like geo:0,0?q=Vienna+Austria
 */
const handleGeoUrl = async (geoUrl: string) => {
	// Remove the 'geo:' prefix and parse the coordinates/query
	const parts = geoUrl.replace('geo:', '').split('?');
	const coords = parts[0].split(',');

	let latitude = coords.length >= 2 ? parseFloat(coords[0]) : NaN;
	let longitude = coords.length >= 2 ? parseFloat(coords[1]) : NaN;
	let zoom = 15;

	if (parts[1]) {
		const parsedParams = parseGeoQueryParams(parts[1]);
		zoom = parsedParams.zoom;
		if (parsedParams.latitude !== undefined && parsedParams.longitude !== undefined) {
			latitude = parsedParams.latitude;
			longitude = parsedParams.longitude;
		}
	}

	// If we have valid non-zero coordinates, navigate directly
	if (!isNaN(latitude) && !isNaN(longitude) && (latitude !== 0 || longitude !== 0)) {
		router.push({
			path: '/',
			query: {
				lat: latitude.toString(),
				lng: longitude.toString(),
				zoom: zoom.toString(),
				external: 'true'
			}
		});
		return;
	}

	// No valid coordinates — try to resolve the `q` parameter as a text search
	const queryPart = parts[1] || '';
	const queryParams = new URLSearchParams(queryPart);
	const qParam = queryParams.get('q');

	if (qParam) {
		// Check if q is a text query (not just coordinates that were already parsed)
		const qTrimmed = qParam.trim();
		if (qTrimmed) {
			try {
				const { searchPhoton, results } = usePhotonSearch();

				// Determine language from navigator or default to 'en'
				const lang = navigator.language?.startsWith('de') ? 'de' : 'en';

				// Use forward geocoding to resolve the text query
				await searchPhoton(qTrimmed, lang);

				if (results.value.length > 0) {
					const feature = results.value[0];
					const [lng, lat] = feature.geometry.coordinates;

					router.push({
						path: '/',
						query: {
							lat: lat.toString(),
							lng: lng.toString(),
							zoom: zoom.toString(),
							external: 'true'
						}
					});
					return;
				}
			} catch (error) {
				console.error('Failed to resolve geo query:', error);
			}
		}
	}

	// Fallback: navigate to home
	router.push('/');
};
