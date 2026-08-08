import { readonly, ref } from 'vue';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * Single source of truth for the operating system's `prefers-color-scheme`
 * preference.
 *
 * The obvious implementation — listen to the media query's `change` event — is
 * not enough on Android. `uiMode` is listed in `android:configChanges`, so the
 * activity is never recreated when the system flips to dark; it only receives
 * `onConfigurationChanged`. When that happens while the app sits in the
 * background, the WebView does not reliably deliver the `change` event, and the
 * missed event never arrives afterwards — so an app that was left open in light
 * mode overnight comes back light even though the phone is now dark.
 *
 * The fix is to stop trusting the event as the only signal and re-read the
 * media query on every transition back to the foreground.
 */

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

const systemPrefersDarkRef = ref(mediaQuery.matches);

/** Reactive mirror of `(prefers-color-scheme: dark)`. */
export const systemPrefersDark = readonly(systemPrefersDarkRef);

type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/**
 * How long after a foreground transition to take a second reading. Android
 * hands the new `uiMode` to the WebView around the time the activity resumes,
 * so a single read at resume time can still see the stale value.
 */
const LATE_RECHECK_MS = 400;

/** Re-reads the media query and notifies listeners if the value changed. */
function refresh(): void {
	const next = mediaQuery.matches;
	if (next === systemPrefersDarkRef.value) return;

	systemPrefersDarkRef.value = next;
	for (const listener of listeners) {
		listener();
	}
}

/**
 * Re-reads the preference now and twice more shortly after, covering the window
 * in which Android has resumed the activity but not yet propagated the new
 * configuration to the WebView.
 */
function refreshWithRetries(): void {
	refresh();
	requestAnimationFrame(refresh);
	window.setTimeout(refresh, LATE_RECHECK_MS);
}

let initialized = false;

/**
 * Starts watching the system preference. Safe to call more than once — only the
 * first call installs listeners.
 */
export function initSystemColorScheme(): void {
	if (initialized) return;
	initialized = true;

	mediaQuery.addEventListener('change', refresh);

	// Foreground transitions: the backstop for a `change` event that was never
	// delivered because the app was in the background when the system flipped.
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
