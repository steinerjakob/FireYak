import type { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoBounds, GeoPoint, boundsContains, distanceTo } from '@/types/geo';
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
import { waterOutlineAt } from '@/mapHandler/obstacleGeometry';

/**
 * Where a hose actually reaches a water source (issue #110).
 *
 * Fire water ponds mapped as an area are shown at their center, but nobody
 * pumps from the middle of a pond. For those the route ends at:
 *   1. a mapped suction point on or next to the pond (the real pumping spot),
 *      the one nearest to the reference location, else
 *   2. the pond's shore: routing picks the best reachable shore point (plan
 *      §6.5), not the straight-line nearest one.
 * Outlines come from the static extract or session cache, else from the
 * Protomaps water polygon under the marker; Overpass is only asked in the
 * background. Everything else — and pond areas without any outline — keeps
 * its marker position.
 */

/** A suction point this close to a pond's outline (or inside it) belongs to it. */
export const SUCTION_POINT_SHORE_TOLERANCE_M = 30;
/**
 * Longest wait for the Protomaps water polygon under a pond marker (a CDN
 * tile, usually cached). Overpass is never awaited (plan §6.9).
 */
export const WATER_POLYGON_WAIT_MS = 1500;

/**
 * Where a route to a water source may end: one point (a hydrant, a mapped
 * suction point at a pond, a pond without a known outline) or a pond's whole
 * shore, of which routing picks the best reachable point. `fallback` is the
 * shore point nearest to the reference location, for straight lines and
 * distance filters.
 */
export type AccessTarget =
	| { kind: 'point'; point: GeoPoint }
	| { kind: 'shore'; outline: GeoJSON.Geometry; fallback: GeoPoint };

/** The single point standing for a target (the fallback shore point for a shore). */
export function accessTargetPoint(target: AccessTarget): GeoPoint {
	return target.kind === 'point' ? target.point : target.fallback;
}

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
 * Access target of `element` seen from `from`, given its outline (if any) and
 * the mapped suction points around it. Synchronous; see the module comment.
 * A mapped suction point within {@link SUCTION_POINT_SHORE_TOLERANCE_M} of the
 * outline is the only goal; otherwise the whole shore is.
 */
export function accessTargetFor(
	element: OverPassElement,
	from: GeoPoint,
	outline: GeoJSON.Geometry | null | undefined,
	suctionPoints: OverPassElement[]
): AccessTarget | null {
	const position = markerPoint(element);
	if (!isPondArea(element) || !outline) return position ? { kind: 'point', point: position } : null;

	// Cheap bounds test first: callers may pass every suction point of a
	// large search window.
	const extent = outlineBounds(outline);
	const reach = extent ? expandBounds(extent, SUCTION_POINT_SHORE_TOLERANCE_M) : null;
	let bestSuction: GeoPoint | null = null;
	let bestSuctionDistance = Infinity;
	for (const candidate of suctionPoints) {
		const point = markerPoint(candidate);
		if (!point || (reach && !boundsContains(reach, point))) continue;
		const toShore = distanceToOutline(outline, point);
		if (toShore === null || toShore > SUCTION_POINT_SHORE_TOLERANCE_M) continue;
		const d = distanceTo(from, point);
		if (d < bestSuctionDistance) {
			bestSuctionDistance = d;
			bestSuction = point;
		}
	}
	if (bestSuction) return { kind: 'point', point: bestSuction };

	const fallback = nearestPointOnOutline(outline, from) ?? position;
	if (!fallback) return null;
	return { kind: 'shore', outline, fallback };
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
 * Starts fetching the outlines of pond areas that don't carry one yet, in the
 * background. Nothing waits for them: late answers land in the session cache,
 * so the next search uses them.
 */
export function preloadPondOutlines(elements: OverPassElement[]): void {
	for (const element of elements) {
		if (!isPondArea(element) || knownOutline(element) || element.id <= 0) continue;
		getAreaOutline(element).catch(() => undefined);
	}
}

/** I/O of {@link resolveAccessPoint}, injectable for specs. */
export interface AccessLookups {
	/** Outline of the Protomaps water polygon under a point (CDN tile). */
	waterOutlineAt: (point: GeoPoint) => Promise<GeoJSON.Geometry | null>;
	/** Cached suction points within bounds. */
	suctionPointsIn: (bounds: GeoBounds) => Promise<OverPassElement[]>;
	/** Overpass outline lookup; only ever started in the background. */
	fetchOutline: (element: OverPassElement) => Promise<GeoJSON.Geometry | null>;
}

const defaultLookups: AccessLookups = {
	waterOutlineAt: (point) => waterOutlineAt(point),
	suctionPointsIn: async (bounds) =>
		(await getMapNodesForView(bounds)).filter(isMappedSuctionPoint),
	fetchOutline: (element) => getAreaOutline(element)
};

/**
 * Pond outline for routing without waiting on Overpass, in the order of
 * plan §6.5: the static extract or session cache, then the Protomaps water
 * polygon under the marker. `null` = route to the marker point.
 */
export async function routingOutline(
	element: OverPassElement,
	lookups: Pick<AccessLookups, 'waterOutlineAt'> = defaultLookups
): Promise<GeoJSON.Geometry | null> {
	const known = knownOutline(element);
	if (known) return known;
	const position = markerPoint(element);
	if (!position) return null;
	return withTimeout(lookups.waterOutlineAt(position), WATER_POLYGON_WAIT_MS);
}

/**
 * Access target of a single element seen from `from`. Never waits for
 * Overpass: a missing outline is requested in the background, and when it
 * arrives `onOutlineArrived` gets the improved target (the caller recomputes
 * silently). Falls back to the marker position on any failure.
 */
export async function resolveAccessPoint(
	element: OverPassElement,
	from: GeoPoint,
	options: { onOutlineArrived?: (target: AccessTarget) => void } = {},
	lookups: AccessLookups = defaultLookups
): Promise<AccessTarget | null> {
	const position = markerPoint(element);
	if (!isPondArea(element)) return position ? { kind: 'point', point: position } : null;
	const fallback: AccessTarget | null = position ? { kind: 'point', point: position } : null;
	try {
		const targetWith = async (outline: GeoJSON.Geometry): Promise<AccessTarget | null> => {
			const bounds = outlineBounds(outline);
			const suctionPoints = bounds
				? await lookups.suctionPointsIn(expandBounds(bounds, SUCTION_POINT_SHORE_TOLERANCE_M))
				: [];
			return accessTargetFor(element, from, outline, suctionPoints);
		};

		if (!knownOutline(element) && element.id > 0) {
			// Background only: the highlight and later searches want the OSM
			// outline, but routing goes ahead with what is at hand.
			lookups
				.fetchOutline(element)
				.then(async (outline) => {
					if (!outline || !options.onOutlineArrived) return;
					const target = await targetWith(outline);
					if (target) options.onOutlineArrived(target);
				})
				.catch(() => undefined);
		}

		const outline = await routingOutline(element, lookups);
		if (!outline) return fallback;
		return (await targetWith(outline)) ?? fallback;
	} catch (e) {
		console.warn('Water source access point failed, using the marker position:', e);
		return fallback;
	}
}
