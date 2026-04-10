import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

/**
 * Base64url-encodes a Uint8Array (no padding, URL-safe alphabet).
 */
export function base64UrlEncode(buffer: Uint8Array): string {
	let binary = '';
	buffer.forEach((byte) => (binary += String.fromCharCode(byte)));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generates a cryptographically random PKCE code verifier.
 * @see https://datatracker.ietf.org/doc/html/rfc7636#section-4.1
 */
export function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64UrlEncode(array);
}

/**
 * Derives a PKCE code challenge from the given verifier using SHA-256.
 * @see https://datatracker.ietf.org/doc/html/rfc7636#section-4.2
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Waits until the Capacitor Activity is active again (Android resumes after closing the in-app browser).
 * This avoids calling native plugins like Preferences while the Activity is still paused/transitioning.
 */
export async function waitForAppToBeActive(timeoutMs = 2000): Promise<void> {
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
