import { Capacitor } from '@capacitor/core';
import type { GeoBounds, GeoPoint } from '@/types/geo';
import { useNetworkStatus } from '@/composable/networkStatus';
import { prefetchTile, routingFetchQueue } from '@/offline/offlineProtocol';
import {
	PRIORITY,
	RING_RADIUS_M,
	boundsAround,
	clipToRadius,
	mapMovePrefetchDue,
	prefetchAllowed,
	ringNeedsRefresh,
	routingTilesForBounds,
	type ConnectionKind,
	type PrefetchNetwork,
	type PrefetchPriority
} from '@/offline/precachePolicy';

/**
 * The three precache triggers of hose routing (plan §6.9), wired to the app:
 * the rules are in `precachePolicy.ts`, the fetching (routing cache, shared
 * queue with 3 requests per source) in `tileFetchers.ts`. Main thread only.
 */

interface NetworkInformationLike {
	type?: string;
	saveData?: boolean;
}

function connectionInfo(): NetworkInformationLike | undefined {
	if (typeof navigator === 'undefined') return undefined;
	return (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
}

/**
 * The network as the precache rules see it. Native: the Capacitor connection
 * type. Web: `navigator.connection.type` where the browser reports it (Chrome
 * on Android); elsewhere (Safari, Firefox, desktop Chrome) it is unknown. The
 * speed class `effectiveType` is not used: "4g" says nothing about Wi-Fi.
 */
export function currentPrefetchNetwork(): PrefetchNetwork {
	const { isOnline, connectionType } = useNetworkStatus();
	const info = connectionInfo();
	let connection: ConnectionKind;
	if (Capacitor.isNativePlatform()) {
		connection = connectionType.value;
	} else {
		const type = info?.type;
		connection =
			type === 'wifi' || type === 'ethernet'
				? 'wifi'
				: type === 'cellular' || type === 'bluetooth'
					? 'cellular'
					: type === 'none'
						? 'none'
						: 'unknown';
	}
	return { online: isOnline.value, saveData: info?.saveData === true, connection };
}

/**
 * Queues the routing tiles of `bounds` at `priority`, replacing the queued
 * (not yet running) tiles of the previous batch of that priority. Resolves
 * with the number of tiles fetched.
 */
export async function prefetchRoutingBounds(
	bounds: GeoBounds,
	priority: PrefetchPriority
): Promise<number> {
	if (!prefetchAllowed(priority, currentPrefetchNetwork())) return 0;
	routingFetchQueue.dropQueued(priority);
	const results = await Promise.all(
		routingTilesForBounds(bounds).map((t) => prefetchTile(t.source, t.z, t.x, t.y, priority))
	);
	return results.filter(Boolean).length;
}

/** Priority 1: the window of the selected route (or the pump line's markers). */
export function prefetchRouteWindow(points: GeoPoint[]): void {
	if (points.length === 0) return;
	let south = Infinity;
	let west = Infinity;
	let north = -Infinity;
	let east = -Infinity;
	for (const p of points) {
		south = Math.min(south, p.lat);
		north = Math.max(north, p.lat);
		west = Math.min(west, p.lng);
		east = Math.max(east, p.lng);
	}
	// The routing window: the bbox plus a quarter of its diagonal, at least 150 m.
	const centre = { lat: (south + north) / 2, lng: (west + east) / 2 };
	const mPerDegLng = 111_320 * Math.cos((centre.lat * Math.PI) / 180);
	const spanM = Math.hypot((north - south) * 110_540, (east - west) * mPerDegLng);
	const margin = Math.max(150, 0.25 * spanM);
	const latPad = margin / 110_540;
	const lngPad = margin / mPerDegLng;
	void prefetchRoutingBounds(
		{ south: south - latPad, north: north + latPad, west: west - lngPad, east: east + lngPad },
		PRIORITY.selection
	);
}

let ringCentre: GeoPoint | null = null;

/** Priority 2: the 2 km ring around the GPS position, refreshed after ≥ 500 m. */
export function updateGpsRing(position: GeoPoint): void {
	if (!ringNeedsRefresh(ringCentre, position)) return;
	if (!prefetchAllowed(PRIORITY.gpsRing, currentPrefetchNetwork())) return;
	ringCentre = position;
	void prefetchRoutingBounds(boundsAround(position, RING_RADIUS_M), PRIORITY.gpsRing);
}

/**
 * Priority 3: the map view after a move (Wi-Fi only), called once the view
 * was idle and its markers were fetched.
 */
export function prefetchMapView(
	bounds: GeoBounds,
	state: { zoom: number; idleMs: number; markersFetched: boolean }
): void {
	if (!mapMovePrefetchDue(state)) return;
	void prefetchRoutingBounds(clipToRadius(bounds), PRIORITY.mapMove);
}
