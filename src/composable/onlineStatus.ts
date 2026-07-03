import { ref } from 'vue';

// ---------------------------------------------------------------------------
// Module-level singleton — all consumers share one reactive ref and one pair
// of event listeners (set up once when the module is first imported).
// ---------------------------------------------------------------------------

const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);

function handleOnline() {
	isOnline.value = true;
}

function handleOffline() {
	isOnline.value = false;
}

if (typeof window !== 'undefined') {
	window.addEventListener('online', handleOnline);
	window.addEventListener('offline', handleOffline);
}

/**
 * Composable that exposes a reactive `isOnline` ref driven by the browser's
 * `navigator.onLine` property and the `window` `online`/`offline` events.
 *
 * No external dependencies — does NOT use `@capacitor/network`.
 */
export function useOnlineStatus() {
	return { isOnline };
}
