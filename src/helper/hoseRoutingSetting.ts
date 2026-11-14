/**
 * The hose routing mode setting and its migration from the old boolean
 * `clamp_hoses_to_roads` (plan §6.7, "from phase 5" column). Pure: the caller
 * reads Preferences and passes the raw stored strings in.
 *
 * Two modes: `optimized` (the default) and `roads`. A stored `direct` (the
 * removed terrain-only mode), a legacy `'false'`/absent boolean and any unknown
 * value all map to `optimized`; the result is written back once and the old key
 * removed.
 */

/** `optimized`: weighted cost grid (default); `roads`: road network only. */
export type HoseRoutingMode = 'optimized' | 'roads';

/** The default mode. */
export const DEFAULT_HOSE_ROUTING: HoseRoutingMode = 'optimized';

/** Preferences key of the mode. */
export const HOSE_ROUTING_KEY = 'hose_routing';
/** Preferences key of the old boolean setting (`'true'` = keep hoses on roads); removed on load. */
export const CLAMP_HOSES_TO_ROADS_KEY = 'clamp_hoses_to_roads';

/** The raw stored values (`null` when absent). */
export interface StoredHoseRouting {
	hoseRouting: string | null;
	clampHosesToRoads: string | null;
}

export interface ResolvedHoseRouting {
	mode: HoseRoutingMode;
	/** Write `mode` to {@link HOSE_ROUTING_KEY} and remove the old key now. */
	shouldPersist: boolean;
}

/**
 * Maps the stored values to the effective mode (plan §6.7 migration table,
 * "from phase 5"). `shouldPersist` is true until the stored state is exactly
 * `hose_routing = mode` without the old key, so the write-back happens once.
 */
export function resolveHoseRouting(stored: StoredHoseRouting): ResolvedHoseRouting {
	const { hoseRouting, clampHosesToRoads } = stored;
	const mode: HoseRoutingMode =
		hoseRouting === 'roads' || (hoseRouting === null && clampHosesToRoads === 'true')
			? 'roads'
			: DEFAULT_HOSE_ROUTING;
	return { mode, shouldPersist: hoseRouting !== mode || clampHosesToRoads !== null };
}

/** The mode the "keep hose route on roads" toggle stands for: on = `roads`, off = `optimized`. */
export function modeFromToggle(keepOnRoads: boolean): HoseRoutingMode {
	return keepOnRoads ? 'roads' : 'optimized';
}
