/**
 * Namespaced marker keys (§4.5 of `plans/selfhost-osm-data.md`).
 *
 * Today every marker is keyed by a bare numeric OSM id. `node/123` and
 * `way/123` are distinct OSM objects that would otherwise overwrite each
 * other in the IndexedDB cache, in a `Map`, and as a MapLibre feature
 * property. An {@link OsmRef} is a single opaque string (`n123`, `w456`,
 * `n-1` for an offline temp create) that works as all three — and crucially
 * as a *single* URL path segment for `/markers/:markerId`.
 */

/** A namespaced OSM element key: `"n123"` (node) or `"w456"` (way). */
export type OsmRef = string;

/** The two OSM element types FireYak deals with. */
export type OsmType = 'node' | 'way';

/** Maps an {@link OsmType} to its {@link OsmRef} prefix letter. */
const REF_PREFIX: Record<OsmType, string> = {
	node: 'n',
	way: 'w'
};

const REF_TYPE_BY_PREFIX: Record<string, OsmType> = {
	n: 'node',
	w: 'way'
};

/**
 * Builds the namespaced ref for an OSM element. `type` is typed loosely
 * (`OsmType | string`) because callers often hand in an {@link OverPassElement}
 * whose `type` field is a plain `string`; anything other than `'way'` is
 * treated as `'node'`, matching the rest of the codebase's node-first defaults.
 */
export function toRef(type: OsmType | string, id: number): OsmRef {
	const prefix = type === 'way' ? REF_PREFIX.way : REF_PREFIX.node;
	return `${prefix}${id}`;
}

/**
 * Parses a namespaced ref back into its type and numeric id. Returns `null`
 * for anything that isn't a valid `n<id>` / `w<id>` ref (including bare
 * numbers — use {@link coerceRef} to accept those).
 */
export function parseRef(ref: OsmRef): { type: OsmType; id: number } | null {
	const match = /^([nw])(-?\d+)$/.exec(ref);
	if (!match) return null;
	return { type: REF_TYPE_BY_PREFIX[match[1]], id: Number(match[2]) };
}

/**
 * Coerces a route/query param into an {@link OsmRef}, accepting both the
 * current `n123` / `w456` format and a bare number.
 *
 * The bare-number case is load-bearing, not legacy cruft to clean up: shared
 * links of the form `https://app.fireyak.org/#/markers/123` are already sitting
 * in users' chat histories, and `/^-?\d+$/` must keep resolving as a node ref
 * forever — new links emit `…/markers/n123`, but old ones must never 404.
 *
 * Returns `null` for garbage input.
 */
export function coerceRef(param: string): OsmRef | null {
	if (parseRef(param) !== null) return param;
	if (/^-?\d+$/.test(param)) return toRef('node', Number(param));
	return null;
}
