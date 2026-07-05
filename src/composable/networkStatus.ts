import { readonly, ref } from 'vue';
import { Network } from '@capacitor/network';

// ---------------------------------------------------------------------------
// Module-level singleton — all consumers share one reactive state and one
// set of listeners (set up once, lazily, on first `useNetworkStatus()` call).
// ---------------------------------------------------------------------------

// Default to online (and to `navigator.onLine` when available as a better
// synchronous first guess) so the UI doesn't flash an offline state before
// `Network.getStatus()` resolves.
const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);
const connectionType = ref<'wifi' | 'cellular' | 'none' | 'unknown'>('unknown');
const onlineCallbacks = new Set<() => void>();
let initialized = false;

async function init() {
	if (initialized) return;
	initialized = true;
	const status = await Network.getStatus();
	isOnline.value = status.connected;
	connectionType.value = status.connectionType;
	Network.addListener('networkStatusChange', (s) => {
		const wasOffline = !isOnline.value;
		isOnline.value = s.connected;
		connectionType.value = s.connectionType;
		if (wasOffline && s.connected) onlineCallbacks.forEach((cb) => cb());
	});
}

/**
 * Composable that exposes reactive network status backed by
 * `@capacitor/network` (web support wraps `navigator.onLine`; native also
 * reports connection type, used for the Wi-Fi-only rule).
 *
 * Replaces/absorbs the phase-2 `onlineStatus.ts` composable — keeps the same
 * `isOnline` export name so call sites don't churn.
 */
export function useNetworkStatus() {
	init();
	return {
		isOnline: readonly(isOnline),
		connectionType: readonly(connectionType),
		/**
		 * Subscribes to offline→online transitions. Returns an unsubscribe
		 * function.
		 */
		onOnline(cb: () => void) {
			onlineCallbacks.add(cb);
			return () => onlineCallbacks.delete(cb);
		}
	};
}
