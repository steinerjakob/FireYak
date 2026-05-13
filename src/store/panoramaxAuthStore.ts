import { defineStore } from 'pinia';
import { onMounted, ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import { OAuthService } from '@/services/OAuthService';
import { useSettings } from '@/composable/settings';
import { fetchPanoramaxUser } from '@/helper/panoramaxApi';
import { waitForAppToBeActive } from '@/helper/pkce';

const PANORAMAX_API_URL = 'https://panoramax.openstreetmap.fr/api';

// Redirect URI for Panoramax OAuth — reuse the app's universal link domain
const REDIRECT_URI = 'https://app.fireyak.org/panoramax-land.html';

// Auth URL: Panoramax uses OSM as identity provider.
// After authorization, Panoramax redirects to REDIRECT_URI with ?token=<JWT>
const PANORAMAX_AUTH_URL = `${PANORAMAX_API_URL}/auth/login`;

export interface PanoramaxUser {
	id: string;
	name: string;
}

/**
 * Module-level flag indicating the InAppBrowser Panoramax OAuth flow is in progress.
 * Used to prevent the appUrlOpen deep-link handler in main.ts from
 * doing a destructive window.location.replace() while the InAppBrowser
 * is still handling the redirect.
 */
let _nativePanoramaxAuthInProgress = false;

/** Returns true while the native InAppBrowser Panoramax OAuth flow is active. */
export function isNativePanoramaxAuthInProgress(): boolean {
	return _nativePanoramaxAuthInProgress;
}

export const usePanoramaxAuthStore = defineStore('panoramaxAuth', () => {
	const isAuthenticated = ref(false);
	const user = ref<PanoramaxUser | null>(null);

	const { savePanoramaxToken, removePanoramaxToken, getPanoramaxToken } = useSettings();

	// Reuse one instance to manage listeners cleanly
	const oauthService = new OAuthService();

	/**
	 * Initiates the Panoramax login flow.
	 * Panoramax uses OSM as its identity provider — users who are already
	 * logged into OSM in their browser will see a one-click authorize screen.
	 */
	async function login() {
		try {
			if (Capacitor.isNativePlatform()) {
				await loginWithInAppBrowser();
			} else {
				await loginWithPopup();
			}
		} catch (e) {
			console.error('Panoramax Login failed', e);
			throw e;
		}
	}

	/**
	 * Web login: opens a popup to the Panoramax OSM auth URL.
	 * The panoramax-land.html page receives the token from the redirect
	 * and sends it back via BroadcastChannel.
	 */
	async function loginWithPopup(): Promise<void> {
		const authUrl =
			`${PANORAMAX_AUTH_URL}?` +
			new URLSearchParams({
				next_url: REDIRECT_URI
			}).toString();

		const popup = window.open(authUrl, 'panoramax-auth', 'width=600,height=700');

		return new Promise<void>((resolve, reject) => {
			const channel = new BroadcastChannel('panoramax-auth-complete');

			// Safety timeout — close the channel if the popup is closed without completing
			const checkClosed = setInterval(() => {
				if (popup && popup.closed) {
					clearInterval(checkClosed);
					channel.close();
					reject(new Error('Authentication cancelled — popup was closed'));
				}
			}, 500);

			channel.onmessage = async (event) => {
				clearInterval(checkClosed);
				try {
					const token = event.data as string;
					if (token) {
						await saveTokenAndFetchUser(token);
						resolve();
					} else {
						reject(new Error('No token received from Panoramax auth'));
					}
				} catch (e) {
					reject(e);
				} finally {
					channel.close();
				}
			};
		});
	}

	/**
	 * Native login: opens the Panoramax OSM auth URL in an InAppBrowser.
	 * Monitors navigation events to detect the redirect back to REDIRECT_URI.
	 * Extracts the token from the redirect URL's ?token= query parameter.
	 */
	async function loginWithInAppBrowser(): Promise<void> {
		_nativePanoramaxAuthInProgress = true;

		const authUrl =
			`${PANORAMAX_AUTH_URL}?` +
			new URLSearchParams({
				redirect_uri: REDIRECT_URI
			}).toString();

		try {
			// The OAuthService monitors for redirects to REDIRECT_URI.
			// Panoramax returns ?token=<JWT> instead of ?code=<code>,
			// so we intercept the full redirect URL and extract the token.
			const redirectUrl = await oauthService.authenticateAndGetFullUrl(authUrl, REDIRECT_URI);

			await waitForAppToBeActive();

			const url = new URL(redirectUrl);
			const token = url.searchParams.get('token');

			if (!token) {
				throw new Error('No token in Panoramax redirect URL');
			}

			await saveTokenAndFetchUser(token);
		} finally {
			await oauthService.cleanup();
			_nativePanoramaxAuthInProgress = false;
		}
	}

	/**
	 * Persists the Panoramax token and fetches user info to confirm it's valid.
	 */
	async function saveTokenAndFetchUser(token: string): Promise<void> {
		await savePanoramaxToken(token);
		await fetchUser(token);
	}

	async function logout() {
		isAuthenticated.value = false;
		user.value = null;
		await removePanoramaxToken();
	}

	/**
	 * Fetches Panoramax user info using the stored token to verify authentication.
	 */
	async function fetchUser(token: string): Promise<void> {
		try {
			const data = await fetchPanoramaxUser(token);

			user.value = {
				id: data.sub,
				name: data.name ?? data.sub
			};
			isAuthenticated.value = true;
		} catch (e) {
			console.error('Failed to fetch Panoramax user', e);
			isAuthenticated.value = false;
			user.value = null;
			throw e;
		}
	}

	/**
	 * Loads the stored Panoramax token and attempts to restore the session.
	 */
	async function loadToken() {
		const token = await getPanoramaxToken();

		if (!token) return;

		try {
			await fetchUser(token);
		} catch {
			// Token is invalid or expired — clear it
			console.warn('Stored Panoramax token is invalid, clearing');
			await removePanoramaxToken();
			isAuthenticated.value = false;
			user.value = null;
		}
	}

	/**
	 * Returns the current stored Panoramax token, or null if not authenticated.
	 */
	async function getToken(): Promise<string | null> {
		return getPanoramaxToken();
	}

	onMounted(() => loadToken());

	return {
		isAuthenticated,
		user,
		login,
		logout,
		loadToken,
		getToken
	};
});
