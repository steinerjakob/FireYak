import type { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoPoint, distanceTo } from '@/types/geo';
import { elementPosition, elementTypeOf, isAreaType } from '@/helper/osmElement';
import { toRef } from '@/helper/osmRef';
import { isSuctionHydrant } from '@/helper/markerTitle';
import {
	distanceToOutline,
	expandBounds,
	nearestPointOnOutline,
	outlineBounds
} from '@/helper/areaShore';
import { cachedOutline, getAreaOutline } from '@/mapHandler/areaOutline';
import { getMapNodesForView } from '@/mapHandler/databaseHandler';

/**
 * Where a hose actually reaches a water source (issue #110).
 *
 * Fire water ponds mapped as an area are shown at their center, but nobody
 * pumps from the middle of a pond. For those the access point is:
 *   1. a mapped suction point on or next to the pond (the real pumping spot),
 *      the one nearest to the reference location, else
 *   2. the point of the pond's shore nearest to the reference location.
 * Everything else — and pond areas whose outline is unknown — keeps its
 * marker position.
 */

/** A suction point this close to a pond's outline (or inside it) belongs to it. */
export const SUCTION_POINT_SHORE_TOLERANCE_M = 30;
/** How long a nearby search waits for missing pond outlines before using centers. */
export const OUTLINE_WAIT_MS = 2500;

/** True for fire water ponds mapped as an area (way/relation). */
export function isPondArea(element: OverPassElement): boolean {
	return element.tags?.['emergency'] === 'fire_water_pond' && isAreaType(elementTypeOf(element));
}

/** True for mapped pumping spots: suction points and suction hydrants. */
export function isMappedSuctionPoint(element: OverPassElement): boolean {
	return element.tags?.['emergency'] === 'suction_point' || isSuctionHydrant(element.tags);
}

/** The element's marker position as a {@link GeoPoint}. */
export function markerPoint(element: OverPassElement): GeoPoint | null {
	const position = elementPosition(element);
	return position ? { lat: position.lat, lng: position.lon } : null;
}

/** The outline already at hand (shipped with the marker or cached), no fetch. */
export function knownOutline(element: OverPassElement): GeoJSON.Geometry | undefined {
	if (!isPondArea(element)) return undefined;
	return element.outline ?? cachedOutline(toRef(elementTypeOf(element), element.id));
}

/**
 * Access point of `element` seen from `from`, given its outline (if any) and
 * the mapped suction points around it. Synchronous; see the module comment.
 */
export function accessPointFor(
	element: OverPassElement,
	from: GeoPoint,
	outline: GeoJSON.Geometry | null | undefined,
	suctionPoints: OverPassElement[]
): GeoPoint | null {
	const position = markerPoint(element);
	if (!isPondArea(element) || !outline) return position;

	let bestSuction: GeoPoint | null = null;
	let bestSuctionDistance = Infinity;
	for (const candidate of suctionPoints) {
		const point = markerPoint(candidate);
		if (!point) continue;
		const toShore = distanceToOutline(outline, point);
		if (toShore === null || toShore > SUCTION_POINT_SHORE_TOLERANCE_M) continue;
		const d = distanceTo(from, point);
		if (d < bestSuctionDistance) {
			bestSuctionDistance = d;
			bestSuction = point;
		}
	}
	if (bestSuction) return bestSuction;

	return nearestPointOnOutline(outline, from) ?? position;
}

/** Resolves `promise`, or `null` once `ms` have passed (the work carries on). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			}
		);
	});
}

/**
 * Fetches the outlines of pond areas that don't carry one yet, waiting at most
 * {@link OUTLINE_WAIT_MS}. Late answers still land in the session cache, so the
 * next search uses them.
 */
export async function preloadPondOutlines(elements: OverPassElement[]): Promise<void> {
	const missing = elements.filter((e) => isPondArea(e) && !knownOutline(e) && e.id > 0);
	if (missing.length === 0) return;
	await withTimeout(Promise.all(missing.map((e) => getAreaOutline(e))), OUTLINE_WAIT_MS);
}

/**
 * Access point of a single element seen from `from`, fetching the pond outline
 * and looking up the cached suction points around it as needed. Falls back to
 * the marker position on any failure.
 */
export async function resolveAccessPoint(
	element: OverPassElement,
	from: GeoPoint
): Promise<GeoPoint | null> {
	const position = markerPoint(element);
	if (!isPondArea(element)) return position;
	try {
		const outline =
			knownOutline(element) ?? (await withTimeout(getAreaOutline(element), OUTLINE_WAIT_MS));
		if (!outline) return position;
		const bounds = outlineBounds(outline);
		const suctionPoints = bounds
			? (await getMapNodesForView(expandBounds(bounds, SUCTION_POINT_SHORE_TOLERANCE_M))).filter(
					isMappedSuctionPoint
				)
			: [];
		return accessPointFor(element, from, outline, suctionPoints);
	} catch (e) {
		console.warn('Water source access point failed, using the marker position:', e);
		return position;
	}
}
