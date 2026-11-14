import type { HoseRoute } from '@/mapHandler/hoseRoutingCore';

/**
 * "Routing data arrived" (plan §6.9). Hose routing never waits for remote data
 * beyond its budget: it routes on what is there and says so in the route's
 * coverage. When a basemap or DEM tile, or a pond outline, lands afterwards
 * (written to the routing cache by then), this module emits
 * {@link ROUTING_DATA_ARRIVED} on {@link routingDataEvents}. Each consumer (the
 * nearby list, the selected line, the pump line) tracks its last request with
 * a {@link RouteFreshness} and recomputes silently when that result was
 * incomplete and data arrived after the request started, so list, label and
 * pump panel converge on the same numbers without user action.
 *
 * Main thread only. No app I/O imported (specs).
 */

export const ROUTING_DATA_ARRIVED = 'routingDataArrived';

/** Arrivals within this window are reported as one event. */
export const ARRIVAL_COALESCE_MS = 250;

export type RoutingDataKind = 'tile' | 'outline';

export interface RoutingDataArrivedDetail {
	/** Tiles and outlines that landed since the previous event. */
	tiles: number;
	outlines: number;
	/** Time of the last arrival (epoch ms). */
	at: number;
}

/** The event target `routingDataArrived` is dispatched on. */
export const routingDataEvents = new EventTarget();

let lastArrivalAt = Number.NEGATIVE_INFINITY;
let pendingTiles = 0;
let pendingOutlines = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
	flushTimer = null;
	const detail: RoutingDataArrivedDetail = {
		tiles: pendingTiles,
		outlines: pendingOutlines,
		at: lastArrivalAt
	};
	pendingTiles = 0;
	pendingOutlines = 0;
	routingDataEvents.dispatchEvent(new CustomEvent(ROUTING_DATA_ARRIVED, { detail }));
}

/**
 * Records that routing data landed (a tile written to the routing cache, a
 * pond outline stored) and schedules one coalesced event.
 */
export function notifyRoutingDataArrived(kind: RoutingDataKind = 'tile'): void {
	lastArrivalAt = Date.now();
	if (kind === 'tile') pendingTiles++;
	else pendingOutlines++;
	flushTimer ??= setTimeout(flush, ARRIVAL_COALESCE_MS);
}

/** Subscribes to {@link ROUTING_DATA_ARRIVED}; returns the unsubscribe function. */
export function onRoutingDataArrived(
	listener: (detail: RoutingDataArrivedDetail) => void
): () => void {
	const handler = (event: Event) =>
		listener((event as CustomEvent<RoutingDataArrivedDetail>).detail);
	routingDataEvents.addEventListener(ROUTING_DATA_ARRIVED, handler);
	return () => routingDataEvents.removeEventListener(ROUTING_DATA_ARRIVED, handler);
}

/** When routing data last landed (epoch ms; −∞ = never). */
export function lastRoutingDataArrivalAt(): number {
	return lastArrivalAt;
}

/** Forgets arrivals and drops a pending event (specs). */
export function resetRoutingData(): void {
	lastArrivalAt = Number.NEGATIVE_INFINITY;
	pendingTiles = 0;
	pendingOutlines = 0;
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = null;
}

/**
 * True when a route was computed on everything it could use: the whole
 * basemap window, the z14 slope raster (when solved on the grid) and a z14
 * profile (when one was asked for). Anything less can improve once late data
 * lands. `null` (not routed) counts as complete: nothing to improve.
 */
export function isRouteDataComplete(route: HoseRoute | null): boolean {
	if (!route) return true;
	const { coverage } = route;
	if (coverage.basemap !== 'full') return false;
	if (coverage.slope !== null && coverage.slope !== 'z14') return false;
	return coverage.dem === 'z14' || coverage.dem === 'off';
}

/**
 * One consumer's view of its latest routing request: whether its result was
 * incomplete and whether data arrived since that request started (data that
 * arrives during a request may or may not have been used, so it counts too;
 * the extra recompute then gives the same numbers and changes nothing).
 */
export class RouteFreshness {
	private startedAt = Number.POSITIVE_INFINITY;
	private complete = true;

	/** Call when a request starts; pass the returned token to {@link finish}. */
	begin(now = Date.now()): number {
		return now;
	}

	/** Records the outcome of the request started at `token` (the latest one wins). */
	finish(token: number, complete: boolean): void {
		this.startedAt = token;
		this.complete = complete;
	}

	/** Forgets the last result (selection cleared, view closed). */
	reset(): void {
		this.startedAt = Number.POSITIVE_INFINITY;
		this.complete = true;
	}

	/** True when the last result was incomplete and data landed since its request started. */
	needsRecompute(lastArrival = lastRoutingDataArrivalAt()): boolean {
		return !this.complete && lastArrival >= this.startedAt;
	}
}
