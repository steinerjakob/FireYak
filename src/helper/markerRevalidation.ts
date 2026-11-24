import type { OverPassElement } from '@/mapHandler/overPassApi';
import { isAreaType } from '@/helper/osmElement';

/**
 * Pure rules for revalidating a cached marker against its live OSM version.
 *
 * The map is served from the static extract (R2) and the local cache, which
 * can be days behind OSM. When a marker is opened or an edit is started, the
 * app shows the cached copy at once and asks OSM for the current version in
 * the background; these helpers decide whether that answer changes anything
 * and how it is folded into the cached row.
 */

/** True when both tag sets hold exactly the same keys and values. */
export function sameTags(
	a: Record<string, string> | undefined,
	b: Record<string, string> | undefined
): boolean {
	const left = a ?? {};
	const right = b ?? {};
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every(
		(key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]
	);
}

/**
 * Folds the live OSM version `fresh` into the cached element `cached`.
 *
 * Returns the element to store, or `null` when nothing visible changed.
 * Tags always follow OSM. A node also takes its live position; an area keeps
 * its cached center and outline (from the extract), since the live read only
 * yields a rough bounding-box center and areas get tag-only edits anyway.
 * Cache bookkeeping fields on `cached` (ref, tile, …) are kept as they are.
 */
export function mergeFreshElement<T extends OverPassElement>(
	cached: T,
	fresh: OverPassElement
): T | null {
	const tagsChanged = !sameTags(cached.tags, fresh.tags);
	if (isAreaType(cached.type)) {
		return tagsChanged ? { ...cached, tags: { ...fresh.tags } } : null;
	}
	const moved =
		fresh.lat != null &&
		fresh.lon != null &&
		(fresh.lat !== cached.lat || fresh.lon !== cached.lon);
	if (!tagsChanged && !moved) return null;
	return {
		...cached,
		tags: { ...fresh.tags },
		...(moved ? { lat: fresh.lat, lon: fresh.lon } : {})
	};
}
