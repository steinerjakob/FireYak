import { fetchElementOutline, type OverPassElement } from '@/mapHandler/overPassApi';
import { toRef, type OsmRef } from '@/helper/osmRef';
import { elementPosition, elementTypeOf, isAreaType } from '@/helper/osmElement';
import { fetchWaterAreasViaApi } from '@/mapHandler/waterAreaLookup';

/**
 * In-memory cache of pond-area outlines for the map highlight (plan Phase 3).
 *
 * Markers only carry a center point, so the outline of a way/relation pond is
 * fetched from Overpass on demand — once per session per element. The
 * water-area search already returns outlines for its candidates and seeds the
 * cache via {@link rememberOutline}, so flagging a candidate needs no extra
 * request. A failed lookup is not cached, so it is retried next time.
 */
const outlines = new Map<OsmRef, GeoJSON.Geometry>();
const inflight = new Map<OsmRef, Promise<GeoJSON.Geometry | null>>();

export function rememberOutline(ref: OsmRef, geometry: GeoJSON.Geometry | undefined): void {
	if (geometry) outlines.set(ref, geometry);
}

/** Returns the cached outline without fetching. */
export function cachedOutline(ref: OsmRef): GeoJSON.Geometry | undefined {
	return outlines.get(ref);
}

/** Outline of a way/relation element (cached, else fetched); `null` for nodes or on failure. */
export async function getAreaOutline(element: OverPassElement): Promise<GeoJSON.Geometry | null> {
	const type = elementTypeOf(element);
	if (!isAreaType(type)) return null;
	// The static extract ships the real polygon with the marker.
	if (element.outline) return element.outline;
	const ref = toRef(type, element.id);
	const cached = outlines.get(ref);
	if (cached) return cached;
	const position = elementPosition(element);
	if (!position || element.id < 0) return null;

	let pending = inflight.get(ref);
	if (!pending) {
		pending = fetchElementOutline(type, element.id, position).finally(() => inflight.delete(ref));
		inflight.set(ref, pending);
	}
	const geometry = await pending;
	if (geometry) outlines.set(ref, geometry);
	return geometry;
}

/**
 * Outlines of the water area a pond **point** lies in, per point (`null` =
 * looked up, none found). Many ponds are mapped only as a node, sometimes
 * inside an unmarked water area; highlighting that area shows which water the
 * point stands for.
 */
const containing = new Map<OsmRef, GeoJSON.Geometry | null>();

/**
 * Outline of the water area that contains a pond node, via the quick OSM API
 * search around it (the same one the add flow uses). Cached per node for the
 * session; a failed lookup is not cached. `null` for non-nodes or when the
 * point lies in no mapped water area.
 */
export async function getContainingWaterOutline(
	element: OverPassElement
): Promise<GeoJSON.Geometry | null> {
	if (elementTypeOf(element) !== 'node') return null;
	const ref = toRef('node', element.id);
	if (containing.has(ref)) return containing.get(ref) ?? null;
	const position = elementPosition(element);
	if (!position) return null;

	const candidates = await fetchWaterAreasViaApi(position.lat, position.lon);
	if (candidates === null) return null; // lookup failed — try again next time
	const inside = candidates.find((c) => c.inside && c.outline);
	const geometry = inside?.outline ?? null;
	containing.set(ref, geometry);
	return geometry;
}
