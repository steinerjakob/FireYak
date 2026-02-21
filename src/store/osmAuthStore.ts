import { defineStore } from 'pinia';
import { ref, onMounted } from 'vue';
import * as OSM from 'osm-api';
import { Preferences } from '@capacitor/preferences';

const OSM_AUTH_KEY = 'osm_auth_token';

// Placeholder values - should be configured via env or settings
const CLIENT_ID = 'PLACEHOLDER_CLIENT_ID';
const REDIRECT_URI = window.location.origin + '/osm-callback';

export const useOsmAuthStore = defineStore('osmAuth', () => {
	const isAuthenticated = ref(false);
	const user = ref<any>(null);

	// Configure OSM API
	OSM.configure({
		apiUrl: 'https://api.openstreetmap.org'
	});

	async function login() {
		try {
			const auth = await OSM.login({
				mode: 'popup',
				clientId: CLIENT_ID,
				redirectUrl: REDIRECT_URI,
				scopes: ['read_prefs', 'write_api']
			});

			if (auth && auth.accessToken) {
				isAuthenticated.value = true;
				await saveToken(auth.accessToken);
				await fetchUser();
			}
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

	async function saveToken(token: string) {
		await Preferences.set({ key: OSM_AUTH_KEY, value: token });
	}

	async function loadToken() {
		const { value } = await Preferences.get({ key: OSM_AUTH_KEY });
		if (value) {
			// osm-api stores token in localStorage by default when using login()
			// If we are loading from Preferences, we might need to sync it back
			// but since it's a web app, it might already be in localStorage.
			// OSM.configure can set the authHeader directly if needed.
			OSM.configure({ authHeader: `Bearer ${value}` });
			if (OSM.isLoggedIn() || value) {
				isAuthenticated.value = true;
				await fetchUser();
			}
		}
	}

	onMounted(loadToken);

	return {
		isAuthenticated,
		user,
		login,
		logout
	};
});
