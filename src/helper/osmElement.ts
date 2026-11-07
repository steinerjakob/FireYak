import type { OverPassElement } from '@/mapHandler/overPassApi';
import type { OsmType } from '@/helper/osmRef';

/**
 * Helpers for editing OSM elements that are not plain nodes.
 *
 * FireYak edits fire water ponds that are mapped on the water area itself (a
 * closed way or a multipolygon relation). For those it only ever changes
 * **tags**: never coordinates, never member nodes, and it never deletes the
 * element — deleting a way would delete the water body and orphan its nodes.
 */

/** True for element types that FireYak treats as areas (tag-only edits). */
export function isAreaType(type: OsmType | string | undefined): boolean {
	return type === 'way' || type === 'relation';
}

/** Normalises a loosely typed `OverPassElement.type` to an {@link OsmType}. */
export function elementTypeOf(element: Pick<OverPassElement, 'type'> | null | undefined): OsmType {
	const type = element?.type;
	return type === 'way' || type === 'relation' ? type : 'node';
}

/**
 * Builds the cache representation of an edited element. Nodes carry
 * `lat`/`lon`; areas carry the given point as `center` (their display
 * position), matching what Overpass `out center` and the static extract
 * deliver for ways and relations.
 */
export function toCacheElement(
	type: OsmType,
	id: number,
	lat: number,
	lon: number,
	tags: Record<string, string>
): OverPassElement {
	if (isAreaType(type)) {
		return { id, type, center: { lat, lon }, tags };
	}
	return { id, type: 'node', lat, lon, tags };
}

/** Display position of an element: its own coordinates, or its area center. */
export function elementPosition(
	element: Pick<OverPassElement, 'lat' | 'lon' | 'center'>
): { lat: number; lon: number } | null {
	const lat = element.lat ?? element.center?.lat;
	const lon = element.lon ?? element.center?.lon;
	return lat != null && lon != null ? { lat, lon } : null;
}

/**
 * Tags that only describe the fire-service use of a pond and are removed when
 * a water area is "unflagged". The wiki documents no pond-specific sub-tags,
 * so this is just the flag itself: the physical tags (`natural=water`,
 * `water=*`, `intermittent`) and general ones (`name`, `access`, `operator`,
 * …) stay — they describe the water body and are valid without the flag.
 */
export const FIRE_POND_ONLY_TAGS = ['emergency'];

/** Returns `tags` with the fire-pond flag and its pond-only sub-tags removed. */
export function withoutFirePondFlag(tags: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(tags).filter(([key]) => !FIRE_POND_ONLY_TAGS.includes(key))
	);
}

/**
 * Physical tags that satisfy the wiki's "requires `natural=water` or similar"
 * rule for `emergency=fire_water_pond`.
 */
export function hasPhysicalWaterTag(tags: Record<string, string>): boolean {
	return (
		tags['natural'] === 'water' || tags['landuse'] === 'reservoir' || tags['landuse'] === 'basin'
	);
}

/** True when an edit removes the fire-pond flag from an element that had it. */
export function isUnflagEdit(
	baseTags: Record<string, string> | null | undefined,
	tags: Record<string, string>
): boolean {
	return baseTags?.['emergency'] === 'fire_water_pond' && tags['emergency'] == null;
}

/**
 * Whether tags still describe something FireYak shows as a marker. An area
 * whose fire-pond flag was removed no longer does, so the cache must drop it
 * (with a tombstone, so the lagging static extract cannot bring it back).
 */
export function isMarkerTags(tags: Record<string, string>): boolean {
	return tags['emergency'] != null || tags['amenity'] === 'fire_station';
}

/**
 * Changeset comment body (without the "via FireYak x.y" suffix) for an edit.
 * Keeps the established `Add/Update/Remove <type>` wording and names areas
 * explicitly so mappers reviewing the changeset see that only tags changed.
 */
export function describeEdit(
	action: 'create' | 'update' | 'delete',
	elementType: OsmType,
	baseTags: Record<string, string> | null | undefined,
	tags: Record<string, string>
): string {
	const markerType = tags['emergency'] || baseTags?.['emergency'] || 'fire_hydrant';
	const area = isAreaType(elementType) ? ` (${elementType})` : '';
	if (action === 'create') return `Add ${markerType}`;
	if (action === 'delete') return `Remove ${markerType}`;
	if (isUnflagEdit(baseTags, tags)) return `Remove fire_water_pond tag from water area${area}`;
	return `Update ${markerType}${area}`;
}
