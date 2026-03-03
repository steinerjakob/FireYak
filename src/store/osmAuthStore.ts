import { defineStore } from 'pinia';
import { onMounted, ref } from 'vue';
import * as OSM from 'osm-api';
import { Capacitor } from '@capacitor/core';
import { OAuthService } from '@/services/OAuthService';
import { App as CapApp } from '@capacitor/app';
import { useSettings } from '@/composable/settings';
import { useSettingsStore } from '@/store/settingsStore';

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

/**
 * Module-level flag indicating the InAppBrowser OAuth flow is in progress.
 * Used to prevent the appUrlOpen deep-link handler in main.ts from
 * doing a destructive window.location.replace() while the InAppBrowser
 * is still exchanging the authorization code.
 */
let _nativeAuthInProgress = false;

/** Returns true while the native InAppBrowser OAuth flow is active. */
export function isNativeAuthInProgress(): boolean {
	return _nativeAuthInProgress;
}

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

/**
 * Waits until the Capacitor Activity is active again (Android resumes after closing the in-app browser).
 * This avoids calling native plugins like Preferences while the Activity is still paused/transitioning.
 */
async function waitForAppToBeActive(timeoutMs = 2000): Promise<void> {
	if (!Capacitor.isNativePlatform()) return;

	const start = Date.now();
	// Fast-path: already active
	try {
		const state = await CapApp.getState();
		if (state.isActive) return;
	} catch {
		// If getState fails for any reason, fall back to a tiny delay.
		await new Promise((r) => setTimeout(r, 50));
		return;
	}

	await new Promise<void>((resolve) => {
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};

		const timer = setInterval(async () => {
			if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				finish();
				return;
			}
			try {
				const s = await CapApp.getState();
				if (s.isActive) {
					clearInterval(timer);
					finish();
				}
			} catch {
				// ignore and keep polling until timeout
			}
		}, 50);
	});
}

export const useOsmAuthStore = defineStore('osmAuth', () => {
	const isAuthenticated = ref(false);
	const user = ref<any>(null);
	console.log("useOsmAuthStore")

	const settingsStore = useSettingsStore();
	const { saveOsmAuthToken, removeOsmAuthToken, getOsmAuthToken } = useSettings();

	// Reuse one instance to manage listeners cleanly
	const oauthService = new OAuthService();

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
					await saveOsmAuthToken(token);
				}
				await fetchUser();
			}
		} catch (e) {
			console.error('OSM Login failed', e);
			throw e;
		}
	}

	/**
	 * Performs OAuth2 PKCE authorization using the @capacitor/inappbrowser.
	 * Opens the OSM authorization page in an in-app WebView, monitors navigation
	 * to detect the redirect back to REDIRECT_URI, extracts the authorization code,
	 * and exchanges it for an access token — all without leaving the app.
	 */
	async function loginWithInAppBrowser(): Promise<void> {
		_nativeAuthInProgress = true;

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

		try {
			const code = await oauthService.authenticate(authUrl, REDIRECT_URI);
			// Key part: wait for Android Activity to be active again before touching Preferences/OSM state.
			await waitForAppToBeActive();
			await exchangeCodeForToken(code, codeVerifier);
		} finally {
			await oauthService.cleanup();
			_nativeAuthInProgress = false;
		}
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

		await new Promise((resolve) => setTimeout(resolve, 2000));
		await saveOsmAuthToken(token);
		await loadToken();
	}

	async function logout() {
		OSM.logout();
		isAuthenticated.value = false;
		user.value = null;
		await removeOsmAuthToken();
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
			console.log("loadToken, logged in")
			const token = OSM.getAuthToken();
			if (token) {
				await saveOsmAuthToken(token);
			}
			await fetchUser();
		} else {
			const value = settingsStore.osmAuthToken || (await getOsmAuthToken());
			console.log("loadToken, not logged in", value, settingsStore.theme)
			if (value) {
				OSM.configure({ authHeader: `Bearer ${value}` });
				await OSM.authReady;
				if (OSM.isLoggedIn()) {
					await fetchUser();
				}
			}
		}
		// On web, if the page was loaded with an OAuth ?code param (e.g. from a
		// redirect that wasn't caught by land.html), clean up the URL.  On native
		// this is unnecessary because the InAppBrowser flow handles the exchange
		// without ever touching window.location.
		if (!Capacitor.isNativePlatform() && window.location.href.includes('?code')) {
			window.location.replace('/');
		}
	}


	onMounted(() => loadToken());

	return {
		isAuthenticated,
		user,
		login,
		logout,
		loadToken
	};
});
