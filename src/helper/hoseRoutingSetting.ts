/**
 * The hose routing mode setting and its migration from the old boolean
 * `clamp_hoses_to_roads` (plan §6.7). Pure: the caller reads Preferences and
 * passes the raw stored strings in.
 *
 * Phases 3-4 (now) are transitional: `optimized` is a preview behind
 * `VITE_HOSE_ROUTING_OPTIMIZED=1` (or a dev build), the effective default stays
 * `direct` (today's terrain grid) and nothing migrated is written back, so no
 * production user sees a change. From phase 5 `optimized` is the default,
 * `direct` is gone and the migrated value is persisted once.
 */

/** `optimized`: weighted cost grid; `roads`: road network only; `direct`: terrain grid (transitional). */
export type HoseRoutingMode = 'optimized' | 'roads' | 'direct';

/** Preferences key of the mode (new). */
export const HOSE_ROUTING_KEY = 'hose_routing';
/** Preferences key of the old boolean setting (`'true'` = keep hoses on roads). */
export const CLAMP_HOSES_TO_ROADS_KEY = 'clamp_hoses_to_roads';

/** Which column of the plan's migration table applies. */
export type HoseRoutingPhase = 'transitional' | 'final';

/** The raw stored values (`null` when absent). */
export interface StoredHoseRouting {
	hoseRouting: string | null;
	clampHosesToRoads: string | null;
}

export interface ResolvedHoseRouting {
	mode: HoseRoutingMode;
	/** Write `mode` to {@link HOSE_ROUTING_KEY} (and drop the old key) now. */
	shouldPersist: boolean;
}

/**
 * True when the `optimized` preview may be offered: dev builds, or builds made
 * with `VITE_HOSE_ROUTING_OPTIMIZED=1` (e.g. Cloudflare previews).
 */
export const HOSE_ROUTING_PREVIEW_AVAILABLE: boolean =
	import.meta.env.DEV || import.meta.env.VITE_HOSE_ROUTING_OPTIMIZED === '1';

/**
 * Maps the stored values to the effective mode (plan §6.7 migration table).
 *
 * @param stored - Raw Preferences values.
 * @param phase - `transitional` (phases 3-4) or `final` (from phase 5).
 * @param optimizedAvailable - Transitional only: whether the preview is enabled
 *   in this build; without it a stored `optimized` falls back to `direct`.
 */
export function resolveHoseRouting(
	stored: StoredHoseRouting,
	phase: HoseRoutingPhase,
	optimizedAvailable = false
): ResolvedHoseRouting {
	const { hoseRouting, clampHosesToRoads } = stored;
	if (phase === 'transitional') {
		// Only an explicit choice is ever saved; a migrated value is not written back.
		const mode: HoseRoutingMode =
			hoseRouting === 'optimized'
				? optimizedAvailable
					? 'optimized'
					: 'direct'
				: hoseRouting === 'roads'
					? 'roads'
					: hoseRouting === 'direct'
						? 'direct'
						: hoseRouting === null && clampHosesToRoads === 'true'
							? 'roads'
							: 'direct';
		return { mode, shouldPersist: false };
	}
	const mode: HoseRoutingMode =
		hoseRouting === 'roads' || (hoseRouting === null && clampHosesToRoads === 'true')
			? 'roads'
			: 'optimized';
	return { mode, shouldPersist: hoseRouting !== mode || clampHosesToRoads !== null };
}

/**
 * The mode the settings toggles stand for: the roads toggle wins; otherwise the
 * preview toggle picks `optimized` where the preview is available, else `direct`.
 */
export function modeFromToggles(
	keepOnRoads: boolean,
	preview: boolean,
	optimizedAvailable: boolean
): HoseRoutingMode {
	if (keepOnRoads) return 'roads';
	return preview && optimizedAvailable ? 'optimized' : 'direct';
}
