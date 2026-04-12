import { defineStore } from 'pinia';
import { onMounted, ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import { OAuthService } from '@/services/OAuthService';
import { useSettings } from '@/composable/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { generateCodeVerifier, generateCodeChallenge, waitForAppToBeActive } from '@/helper/pkce';

// Environment-based configuration with production fallbacks
const WIKIMEDIA_CLIENT_ID =
	import.meta.env.VITE_WIKIMEDIA_CLIENT_ID || 'c3f1191425e370137462408619af11c1';
const WIKIMEDIA_BASE_URL = import.meta.env.VITE_WIKIMEDIA_BASE_URL || 'https://meta.wikimedia.org';
const COMMONS_API_URL =
	import.meta.env.VITE_COMMONS_API_URL || 'https://commons.wikimedia.org/w/api.php';

const WIKIMEDIA_AUTH_URL = `${WIKIMEDIA_BASE_URL}/w/rest.php/oauth2/authorize`;
const WIKIMEDIA_TOKEN_URL = `${WIKIMEDIA_BASE_URL}/w/rest.php/oauth2/access_token`;

// Redirect URI — same for both native and web (universal link)
const REDIRECT_URI = 'https://app.fireyak.org/wikimedia-land.html';

const SCOPES = ['basic', 'editpage', 'uploadfile'] as const;

export interface WikimediaUser {
	name: string;
	id: number;
}

/**
 * Module-level flag indicating the InAppBrowser OAuth flow is in progress.
 * Used to prevent the appUrlOpen deep-link handler in main.ts from
 * doing a destructive window.location.replace() while the InAppBrowser
 * is still exchanging the authorization code.
 */
let _nativeWikimediaAuthInProgress = false;

/** Returns true while the native InAppBrowser Wikimedia OAuth flow is active. */
export function isNativeWikimediaAuthInProgress(): boolean {
	return _nativeWikimediaAuthInProgress;
}

export const useWikimediaAuthStore = defineStore('wikimediaAuth', () => {
	const isAuthenticated = ref(false);
	const user = ref<WikimediaUser | null>(null);

	const settingsStore = useSettingsStore();
	const {
		saveWikimediaTokens,
		removeWikimediaTokens,
		getWikimediaAccessToken,
		getWikimediaRefreshToken
	} = useSettings();

	// Reuse one instance to manage listeners cleanly
	const oauthService = new OAuthService();

	async function login() {
		try {
			if (Capacitor.isNativePlatform()) {
				await loginWithInAppBrowser();
			} else {
				await loginWithPopup();
			}
		} catch (e) {
			console.error('Wikimedia Login failed', e);
			throw e;
		}
	}

	/**
	 * Performs OAuth2 PKCE authorization using a popup window (web).
	 * Opens the Wikimedia authorization page in a popup, listens for the
	 * authorization code via BroadcastChannel, and exchanges it for tokens.
	 */
	async function loginWithPopup(): Promise<void> {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await generateCodeChallenge(codeVerifier);

		const authUrl =
			`${WIKIMEDIA_AUTH_URL}?` +
			new URLSearchParams({
				client_id: WIKIMEDIA_CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				response_type: 'code',
				scope: SCOPES.join(' '),
				code_challenge: codeChallenge,
				code_challenge_method: 'S256'
			}).toString();

		const popup = window.open(authUrl, 'wikimedia-auth', 'width=600,height=700');

		return new Promise<void>((resolve, reject) => {
			const channel = new BroadcastChannel('wikimedia-auth-complete');

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
					const url = new URL(event.data);
					const code = url.searchParams.get('code');
					if (code) {
						await exchangeCodeForToken(code, codeVerifier);
						resolve();
					} else {
						reject(new Error('No authorization code received'));
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
	 * Performs OAuth2 PKCE authorization using the @capacitor/inappbrowser.
	 * Opens the Wikimedia authorization page in an in-app WebView, monitors navigation
	 * to detect the redirect back to REDIRECT_URI, extracts the authorization code,
	 * and exchanges it for tokens — all without leaving the app.
	 */
	async function loginWithInAppBrowser(): Promise<void> {
		_nativeWikimediaAuthInProgress = true;

		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await generateCodeChallenge(codeVerifier);

		const authUrl =
			`${WIKIMEDIA_AUTH_URL}?` +
			new URLSearchParams({
				client_id: WIKIMEDIA_CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				response_type: 'code',
				scope: SCOPES.join(' '),
				code_challenge: codeChallenge,
				code_challenge_method: 'S256'
			}).toString();

		try {
			const code = await oauthService.authenticate(authUrl, REDIRECT_URI);
			// Wait for Android Activity to be active again before touching Preferences
			await waitForAppToBeActive();
			await exchangeCodeForToken(code, codeVerifier);
		} finally {
			await oauthService.cleanup();
			_nativeWikimediaAuthInProgress = false;
		}
	}

	/**
	 * Exchanges an OAuth2 authorization code for access and refresh tokens
	 * using the PKCE code verifier.
	 */
	async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<void> {
		const response = await fetch(WIKIMEDIA_TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: REDIRECT_URI,
				client_id: WIKIMEDIA_CLIENT_ID,
				code_verifier: codeVerifier
			}).toString()
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token exchange failed (${response.status}): ${text}`);
		}

		const data = await response.json();
		const accessToken = data.access_token;
		const refreshToken = data.refresh_token;

		if (!accessToken) {
			throw new Error('No access_token in token response');
		}

		await saveWikimediaTokens(accessToken, refreshToken || '');
		await fetchUser(true);
	}

	async function logout() {
		isAuthenticated.value = false;
		user.value = null;
		await removeWikimediaTokens();
	}

	/**
	 * Fetches the authenticated Wikimedia user info from the Commons API.
	 * Uses action=query&meta=userinfo with a Bearer token.
	 */
	async function fetchUser(force = false): Promise<void> {
		const token = settingsStore.wikimediaAccessToken || (await getWikimediaAccessToken());

		if (!token) {
			isAuthenticated.value = false;
			return;
		}

		try {
			const url = `https://commons.wikimedia.org/w/rest.php/oauth2/resource/profile`;
			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${token}`
				}
			});

			if (!response.ok) {
				throw new Error(`Userinfo request failed (${response.status})`);
			}

			const data = await response.json();

			if (data && data.sub && data.username) {
				user.value = { name: data.username, id: data.sub };
				isAuthenticated.value = true;
			} else {
				// Anonymous / invalid token
				isAuthenticated.value = false;
				user.value = null;
			}
		} catch (e) {
			console.error('Failed to fetch Wikimedia user', e);
			isAuthenticated.value = false;
			user.value = null;
			throw e;
		}
	}

	/**
	 * Refreshes the Wikimedia access token using the stored refresh token.
	 */
	async function refreshAccessToken(): Promise<void> {
		const refreshToken = settingsStore.wikimediaRefreshToken || (await getWikimediaRefreshToken());

		if (!refreshToken) {
			throw new Error('No refresh token available');
		}

		const response = await fetch(WIKIMEDIA_TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: WIKIMEDIA_CLIENT_ID
			}).toString()
		});

		if (!response.ok) {
			throw new Error('Token refresh failed');
		}

		const data = await response.json();
		await saveWikimediaTokens(data.access_token, data.refresh_token);
	}

	/**
	 * Loads the stored Wikimedia token and attempts to restore the session.
	 * If the stored token is expired, tries to refresh it.
	 */
	async function loadToken() {
		const token = settingsStore.wikimediaAccessToken || (await getWikimediaAccessToken());

		if (!token) return;

		try {
			await fetchUser(true);
		} catch {
			// Token may be expired — attempt refresh
			try {
				await refreshAccessToken();
				await fetchUser(true);
			} catch (refreshError) {
				console.error('Wikimedia token refresh failed', refreshError);
				// Both attempts failed — clear tokens
				await removeWikimediaTokens();
				isAuthenticated.value = false;
				user.value = null;
			}
		}
	}

	onMounted(() => loadToken());

	return {
		isAuthenticated,
		user,
		login,
		logout,
		loadToken,
		refreshAccessToken
	};
});
