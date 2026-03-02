import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as OSM from 'osm-api';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { InAppBrowser } from '@capgo/inappbrowser';

const OSM_AUTH_KEY = 'osm_auth_token';

// Placeholder values - should be configured via env or settings
const CLIENT_ID = '5RmzpVAEyynIFoe3Lj5IdMvQ-1L-Z1ZhzQ0U33JJE-o';

// On native, the redirect URI is the Capacitor server origin so the OAuth callback
// stays in the local app context. On web, it points to land.html which uses a
// BroadcastChannel to hand the auth code back to the popup opener (osm-api).
const REDIRECT_URI = Capacitor.isNativePlatform()
	? 'https://app.fireyak.org'
	: `${window.location.origin}/land.html`;

const OSM_BASE_URL = 'https://www.openstreetmap.org';
const OSM_AUTH_URL = `${OSM_BASE_URL}/oauth2/authorize`;
const OSM_TOKEN_URL = `${OSM_BASE_URL}/oauth2/token`;

const SCOPES = ['read_prefs', 'write_api'] as const;

// Configure OSM API
// OSM.configure({
// 	apiUrl: 'https://master.apis.dev.openstreetmap.org'
// });

/**
 * Generates a cryptographically random PKCE code verifier.
 * @see https://datatracker.ietf.org/doc/html/rfc7636#section-4.1
 */
function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64UrlEncode(array);
}

/**
 * Base64url-encodes a Uint8Array (no padding, URL-safe alphabet).
 */
function base64UrlEncode(buffer: Uint8Array): string {
	let binary = '';
	buffer.forEach((byte) => (binary += String.fromCharCode(byte)));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derives a PKCE code challenge from the given verifier using SHA-256.
 * @see https://datatracker.ietf.org/doc/html/rfc7636#section-4.2
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(digest));
}

export const useOsmAuthStore = defineStore('osmAuth', () => {
	const isAuthenticated = ref(false);
	const user = ref<any>(null);

	async function login() {
		try {
			if (Capacitor.isNativePlatform()) {
				await loginWithInAppBrowser();
			} else {
				// On web, use popup-based OAuth flow — land.html receives the code
				// and sends it back via BroadcastChannel so the page never navigates away
				await OSM.login({
					mode: 'popup',
					clientId: CLIENT_ID,
					redirectUrl: REDIRECT_URI,
					scopes: SCOPES
				});
				// After popup completes, persist the token and fetch the user
				const token = OSM.getAuthToken();
				if (token) {
					await Preferences.set({ key: OSM_AUTH_KEY, value: token });
				}
				await fetchUser();
			}
		} catch (e) {
			console.error('OSM Login failed', e);
			throw e;
		}
	}

	/**
	 * Performs OAuth2 PKCE authorization using the @capgo/inappbrowser.
	 * Opens the OSM authorization page in an in-app WebView, monitors URL changes
	 * to detect the redirect back to REDIRECT_URI, extracts the authorization code,
	 * and exchanges it for an access token — all without leaving the app.
	 */
	async function loginWithInAppBrowser(): Promise<void> {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await generateCodeChallenge(codeVerifier);

		const authUrl =
			`${OSM_AUTH_URL}?` +
			new URLSearchParams({
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				response_type: 'code',
				scope: SCOPES.join(' '),
				code_challenge: codeChallenge,
				code_challenge_method: 'S256'
			}).toString();

		return new Promise<void>((resolve, reject) => {
			let settled = false;

			const cleanup = async () => {
				await InAppBrowser.removeAllListeners();
			};

			// Monitor URL changes in the WebView to detect the OAuth redirect
			InAppBrowser.addListener('urlChangeEvent', async (event) => {
				if (settled || !event.url) return;
				if (!event.url.startsWith(REDIRECT_URI)) return;

				settled = true;
				await cleanup();

				const url = new URL(event.url);
				const code = url.searchParams.get('code');
				const error = url.searchParams.get('error');

				await InAppBrowser.close();

				if (error) {
					reject(new Error(`OAuth authorization error: ${error}`));
					return;
				}

				if (!code) {
					reject(new Error('No authorization code received from OSM'));
					return;
				}

				try {
					await exchangeCodeForToken(code, codeVerifier);
					resolve();
				} catch (e) {
					reject(e);
				}
			});

			// Handle the case where the user closes the browser manually
			InAppBrowser.addListener('closeEvent', () => {
				if (!settled) {
					settled = true;
					cleanup();
					reject(new Error('Authentication cancelled — browser was closed'));
				}
			});

			// Open the OAuth page in the in-app WebView
			InAppBrowser.openWebView({
				url: authUrl,
				title: 'OpenStreetMap Login',
				isPresentAfterPageLoad: false,
				preventDeeplink: true
			});
		});
	}

	/**
	 * Exchanges an OAuth2 authorization code for an access token
	 * using the PKCE code verifier, then configures osm-api.
	 */
	async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<void> {
		const response = await fetch(OSM_TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: REDIRECT_URI,
				client_id: CLIENT_ID,
				code_verifier: codeVerifier
			}).toString()
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token exchange failed (${response.status}): ${text}`);
		}

		const data = await response.json();
		const token = data.access_token;

		if (!token) {
			throw new Error('No access_token in token response');
		}

		// Persist the token and configure osm-api
		OSM.configure({ authHeader: `Bearer ${token}` });
		await Preferences.set({ key: OSM_AUTH_KEY, value: token });
		await fetchUser();
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
		if (window.location.href.includes('?code')) {
			window.location.replace('/');
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
