import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Preferences } from '@capacitor/preferences';
import { getDataMetadata } from '@/mapHandler/staticDataApi';

const PLANET_TIMESTAMP_KEY = 'data_planet_timestamp';

/**
 * ISO planet timestamp of the static water-source extract currently in use, or
 * `null` while unknown. Module-level so every view shares one value and the
 * network lookup happens once per session.
 */
const planetTimestamp = ref<string | null>(null);
let loaded = false;

/**
 * Freshness of the self-published OSM extract ("Data as of …", §4.9).
 *
 * The value is persisted via Capacitor Preferences and rendered from that cache
 * first: the app is offline-capable and no Workbox rule covers the data host, so
 * a network read would otherwise leave the line blank exactly when a user is
 * offline and most wants to know how current their data is.
 */
export function useDataFreshness() {
	const { locale } = useI18n();

	/** Reads the cached value, then refreshes it from the network in the background. */
	async function load(): Promise<void> {
		if (loaded) return;

		try {
			const cached = await Preferences.get({ key: PLANET_TIMESTAMP_KEY });
			if (cached.value) planetTimestamp.value = cached.value;
		} catch {
			// Preferences unavailable — fall through to the network lookup.
		}

		const meta = await getDataMetadata();
		// Only latch on success, so a lookup that failed while offline is retried
		// the next time the user opens this view rather than staying stale for the
		// rest of the session.
		if (!meta?.planet_timestamp) return;
		loaded = true;

		planetTimestamp.value = meta.planet_timestamp;
		try {
			await Preferences.set({ key: PLANET_TIMESTAMP_KEY, value: meta.planet_timestamp });
		} catch {
			// Non-fatal: the value still renders for this session.
		}
	}

	/**
	 * Localised date, or `null` when the timestamp is unknown or unparseable.
	 *
	 * Rendered in **UTC**, not local time. The planet timestamp is the instant
	 * the OSM extract was cut and typically lands seconds before midnight UTC
	 * (e.g. `2026-07-12T23:59:57Z`), so formatting it locally would roll the
	 * date forward a day for every user east of UTC — making the data look one
	 * day fresher than it is.
	 */
	function formatted(): string | null {
		if (!planetTimestamp.value) return null;
		const parsed = Date.parse(planetTimestamp.value);
		if (Number.isNaN(parsed)) return null;
		return new Date(parsed).toLocaleDateString(locale.value || 'en', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}

	return { planetTimestamp, load, formatted };
}
