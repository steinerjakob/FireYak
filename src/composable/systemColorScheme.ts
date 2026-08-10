import { readonly, ref } from 'vue';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * Single source of truth for the OS `prefers-color-scheme` preference.
 *
 * The media query's `change` event alone is not enough: `uiMode` is in
 * `android:configChanges`, so a system theme switch never recreates the
 * activity, and the WebView drops the event while the app is backgrounded. So
 * we also re-read the query on every transition back to the foreground.
 */

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

const systemPrefersDarkRef = ref(mediaQuery.matches);

/** Reactive mirror of `(prefers-color-scheme: dark)`. */
export const systemPrefersDark = readonly(systemPrefersDarkRef);

type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** Android propagates the new `uiMode` to the WebView just after resume. */
const LATE_RECHECK_MS = 400;

function refresh(): void {
	const next = mediaQuery.matches;
	if (next === systemPrefersDarkRef.value) return;

	systemPrefersDarkRef.value = next;
	for (const listener of listeners) {
		listener();
	}
}

function refreshWithRetries(): void {
	refresh();
	requestAnimationFrame(refresh);
	window.setTimeout(refresh, LATE_RECHECK_MS);
}

let initialized = false;

/** Starts watching the system preference. Only the first call has an effect. */
export function initSystemColorScheme(): void {
	if (initialized) return;
	initialized = true;

	mediaQuery.addEventListener('change', refresh);

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') refreshWithRetries();
	});
	window.addEventListener('focus', refreshWithRetries);

	if (Capacitor.isNativePlatform()) {
		void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
			if (isActive) refreshWithRetries();
		});
		void CapacitorApp.addListener('resume', refreshWithRetries);
	}
}

/** Registers a callback fired whenever the system preference changes. */
export function onSystemColorSchemeChange(listener: ChangeListener): void {
	listeners.add(listener);
}
