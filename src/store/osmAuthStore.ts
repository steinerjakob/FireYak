import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as OSM from 'osm-api';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

const OSM_AUTH_KEY = 'osm_auth_token';

// Placeholder values - should be configured via env or settings
const CLIENT_ID = '5RmzpVAEyynIFoe3Lj5IdMvQ-1L-Z1ZhzQ0U33JJE-o';
// const CLIENT_ID = 'HrEk30DIuyw_bUOodnWs8Uept4nHFYqaSqf-IDbH4rw';

// In native, the Capacitor WebView is configured to serve the app at this origin,
// so the OAuth redirect lands back in the local app context (same localStorage origin).
// In web dev, the Vite dev server origin is used.
const REDIRECT_URI = Capacitor.isNativePlatform() ? 'https://app.fireyak.org' : window.location.origin;

// Configure OSM API
// OSM.configure({
// 	apiUrl: 'https://master.apis.dev.openstreetmap.org'
// });

export const useOsmAuthStore = defineStore('osmAuth', () => {
	const isAuthenticated = ref(false);
	const user = ref<any>(null);

	async function login() {
		try {
			await OSM.login({
				mode: 'redirect',
				clientId: CLIENT_ID,
				redirectUrl: REDIRECT_URI,
				scopes: ['read_prefs', 'write_api', 'write_notes']
			});
		} catch (e) {
			console.error('OSM Login failed', e);
			throw e;
		}
	}

	async function logout() {
		OSM.logout();
		isAuthenticated.value = false;
		user.value = null;
		await Preferences.remove({ key: OSM_AUTH_KEY });
	}

	async function fetchUser() {
		if (!OSM.isLoggedIn()) {
			isAuthenticated.value = false;
			return;
		}
		try {
			user.value = await OSM.getUser('me');
			isAuthenticated.value = true;
		} catch (e) {
			console.error('Failed to fetch OSM user', e);
			isAuthenticated.value = false;
		}
	}

	async function loadToken() {
		await OSM.authReady;

		if (OSM.isLoggedIn()) {
			const token = OSM.getAuthToken();
			if (token) {
				await Preferences.set({ key: OSM_AUTH_KEY, value: token });
			}
			await fetchUser();
		} else {
			const { value } = await Preferences.get({ key: OSM_AUTH_KEY });
			if (value) {
				OSM.configure({ authHeader: `Bearer ${value}` });
				if (OSM.isLoggedIn()) {
					await fetchUser();
				}
			}
		}
	}

	return {
		isAuthenticated,
		user,
		login,
		logout,
		loadToken
	};
});
