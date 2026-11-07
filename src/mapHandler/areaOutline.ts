import { fetchElementOutline, type OverPassElement } from '@/mapHandler/overPassApi';
import { toRef, type OsmRef } from '@/helper/osmRef';
import { elementPosition, elementTypeOf, isAreaType } from '@/helper/osmElement';

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
