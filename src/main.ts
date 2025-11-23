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
import '@ionic/vue/css/palettes/dark.system.css';

import '@/theme/variables.scss';
import '@/theme/md3/theme.css';

import '@/plugins/statusBarHandling.ts';

// Components
import App from './App.vue';

// Composables
import { createApp } from 'vue';
import { updateEdge2Edge } from '@/plugins/statusBarHandling';

const app = createApp(App);

registerPlugins(app);

router.isReady().then(async () => {
	await updateEdge2Edge();
	app.mount('#app');
});

CapApp.addListener('appUrlOpen', function (event: URLOpenListenerEvent) {
	const url = event.url;
	console.log('App opened with URL:', url);

	// 1. Check if the URL is a location URL you want to handle
	if (url.startsWith('geo:')) {
		handleGeoUrl(url);
		return;
	}

	const slug = event.url.split('#').pop();

	// We only push to the route if there is a slug present
	if (slug) {
		router.push({
			path: slug
		});
	}
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
 */
const handleGeoUrl = (geoUrl: string) => {
	// Remove the 'geo:' prefix and parse the coordinates/query
	const parts = geoUrl.replace('geo:', '').split('?');
	const coords = parts[0].split(',');

	if (coords.length >= 2) {
		let latitude = parseFloat(coords[0]);
		let longitude = parseFloat(coords[1]);
		let zoom = 15;

		if (parts[1]) {
			const parsedParams = parseGeoQueryParams(parts[1]);
			zoom = parsedParams.zoom;
			if (parsedParams.latitude !== undefined && parsedParams.longitude !== undefined) {
				latitude = parsedParams.latitude;
				longitude = parsedParams.longitude;
			}
		}

		// Navigate to the map with the location and external flag
		router.push({
			path: '/',
			query: {
				lat: latitude.toString(),
				lng: longitude.toString(),
				zoom: zoom.toString(),
				external: 'true'
			}
		});
	}
};
