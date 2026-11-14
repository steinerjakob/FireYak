import { distanceTo, type GeoBounds, type GeoPoint } from '@/types/geo';
import {
	PROTOMAPS_MAX_ZOOM,
	TERRAIN_MAX_ZOOM,
	TERRAIN_ROUTING_ZOOM,
	tilesForBounds
} from '@/offline/tileMath';

/**
 * When and what to precache for hose routing (plan §6.9), and the fetch queue
 * that limits concurrent requests per source and lets more urgent work go
 * first. Pure: network state, positions and the fetch itself are passed in.
 *
 * Only CDN tiles are precached (the routing basemap z15 and the terrain DEM
 * z14 and z12), never Overpass. The triggers, most urgent first:
 *
 * 1. the selected route or the pump-calculation window;
 * 2. a 2 km ring around the GPS position, refreshed after moving ≥ 500 m;
 * 3. the map view after a move at zoom ≥ 14, 1.5 s idle and the marker
 *    fetch, on Wi-Fi only.
 *
 * Nothing is prefetched offline or with the browser's data saver. Where the
 * connection type is unknown (the web build in Safari/Firefox and desktop
 * Chrome, plan §10 question 4) the Wi-Fi-only trigger 3 does not run; 1 and 2
 * still do, since they fetch what the next route is about to need anyway.
 */

/** Radius of the GPS ring. */
export const RING_RADIUS_M = 2000;
/** The ring is refreshed once the position moved this far from its centre. */
export const RING_REFRESH_M = 500;
/** Map-move precaching needs at least this zoom. */
export const MAP_MOVE_MIN_ZOOM = 14;
/** …and this long without a further move. */
export const MAP_MOVE_IDLE_MS = 1500;
/** Concurrent network requests per tile source (routing and prefetch together). */
export const MAX_CONCURRENT_PER_SOURCE = 3;
/** Map-move precaching covers at most this far from the view centre (a zoomed-out tablet). */
export const MAP_MOVE_MAX_RADIUS_M = 1500;

/** Request priorities; a lower number goes first. */
export const PRIORITY = {
	/** A routing request waiting for the tile. */
	routing: 0,
	selection: 1,
	gpsRing: 2,
	mapMove: 3
} as const;

export type PrefetchPriority = (typeof PRIORITY)[Exclude<keyof typeof PRIORITY, 'routing'>];

export type ConnectionKind = 'wifi' | 'cellular' | 'unknown' | 'none';

export interface PrefetchNetwork {
	online: boolean;
	/** The browser's/OS's data saver (`navigator.connection.saveData`). */
	saveData: boolean;
	connection: ConnectionKind;
}

/** Whether a prefetch of `priority` may run on this network. */
export function prefetchAllowed(priority: PrefetchPriority, network: PrefetchNetwork): boolean {
	if (!network.online || network.saveData || network.connection === 'none') return false;
	if (priority === PRIORITY.mapMove) return network.connection === 'wifi';
	return true;
}

/** True when the GPS ring must be (re)filled: none yet, or moved ≥ {@link RING_REFRESH_M}. */
export function ringNeedsRefresh(
	ringCentre: GeoPoint | null,
	position: GeoPoint,
	thresholdM = RING_REFRESH_M
): boolean {
	return ringCentre === null || distanceTo(ringCentre, position) >= thresholdM;
}

/** Whether a map move is due for precaching (the Wi-Fi rule is {@link prefetchAllowed}'s). */
export function mapMovePrefetchDue(state: {
	zoom: number;
	idleMs: number;
	markersFetched: boolean;
}): boolean {
	return (
		state.zoom >= MAP_MOVE_MIN_ZOOM && state.idleMs >= MAP_MOVE_IDLE_MS && state.markersFetched
	);
}

/** Square bounds of `radiusM` around `center`. */
export function boundsAround(center: GeoPoint, radiusM: number): GeoBounds {
	const latDelta = radiusM / 110_540;
	const lngDelta = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
	return {
		south: center.lat - latDelta,
		north: center.lat + latDelta,
		west: center.lng - lngDelta,
		east: center.lng + lngDelta
	};
}

/** `bounds` clipped to {@link MAP_MOVE_MAX_RADIUS_M} around its centre. */
export function clipToRadius(bounds: GeoBounds, radiusM = MAP_MOVE_MAX_RADIUS_M): GeoBounds {
	const centre = { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 };
	const max = boundsAround(centre, radiusM);
	return {
		south: Math.max(bounds.south, max.south),
		north: Math.min(bounds.north, max.north),
		west: Math.max(bounds.west, max.west),
		east: Math.min(bounds.east, max.east)
	};
}

export interface TileRef {
	source: string;
	z: number;
	x: number;
	y: number;
}

/**
 * The tiles a route inside `bounds` reads: basemap z15, terrain z14 (slope and
 * profile) and z12 (their fallback). Ordered basemap first, then z14, z12.
 */
export function routingTilesForBounds(bounds: GeoBounds): TileRef[] {
	const out: TileRef[] = [];
	for (const t of tilesForBounds(bounds, PROTOMAPS_MAX_ZOOM, PROTOMAPS_MAX_ZOOM)) {
		out.push({ source: 'protomaps', ...t });
	}
	for (const z of [TERRAIN_ROUTING_ZOOM, TERRAIN_MAX_ZOOM]) {
		for (const t of tilesForBounds(bounds, z, z)) out.push({ source: 'terrain', ...t });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Fetch queue
// ---------------------------------------------------------------------------

/** Rejection of a job dropped from the queue (superseded prefetch). */
export class QueueDroppedError extends Error {
	constructor() {
		super('Tile request dropped');
		this.name = 'QueueDroppedError';
	}
}

interface Job<T> {
	key: string;
	source: string;
	priority: number;
	run: (signal: AbortSignal) => Promise<T>;
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	/** Set while running. */
	controller: AbortController | null;
	/** Aborted to make room for more urgent work: goes back into the queue. */
	preempted: boolean;
	/** Order of arrival, FIFO within a priority. */
	seq: number;
}

/**
 * Network queue shared by routing and precaching: at most `maxPerSource`
 * requests run per source; a request for a key already queued or running
 * joins it (and raises its priority); the most urgent queued job starts
 * first; when every slot of a source is taken by less urgent work, the least
 * urgent running job is aborted and queued again, so routing never waits
 * behind a prefetch. Jobs of a superseded prefetch batch can be dropped.
 */
export class FetchQueue<T> {
	private readonly jobs = new Map<string, Job<T>>();
	private readonly queued: Job<T>[] = [];
	private readonly running = new Map<string, Set<Job<T>>>();
	private seq = 0;

	constructor(private readonly maxPerSource = MAX_CONCURRENT_PER_SOURCE) {}

	/** Runs (or joins) the job for `key`; resolves with its result. */
	request(
		key: string,
		source: string,
		priority: number,
		run: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		const existing = this.jobs.get(key);
		if (existing) {
			if (priority < existing.priority) {
				existing.priority = priority;
				this.pump(source);
			}
			return existing.promise;
		}
		let resolve!: (value: T) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const job: Job<T> = {
			key,
			source,
			priority,
			run,
			promise,
			resolve,
			reject,
			controller: null,
			preempted: false,
			seq: this.seq++
		};
		this.jobs.set(key, job);
		this.queued.push(job);
		this.pump(source);
		return promise;
	}

	/** Drops queued (not running) jobs of exactly `priority`; they reject with {@link QueueDroppedError}. */
	dropQueued(priority: number): number {
		let dropped = 0;
		for (let i = this.queued.length - 1; i >= 0; i--) {
			const job = this.queued[i];
			if (job.priority !== priority) continue;
			this.queued.splice(i, 1);
			this.jobs.delete(job.key);
			job.reject(new QueueDroppedError());
			dropped++;
		}
		return dropped;
	}

	/** Requests running for `source`. */
	runningCount(source: string): number {
		return this.running.get(source)?.size ?? 0;
	}

	/** Jobs waiting for a slot. */
	queuedCount(): number {
		return this.queued.length;
	}

	/** True while a job for `key` is queued or running. */
	isPending(key: string): boolean {
		return this.jobs.has(key);
	}

	private nextQueued(source: string): Job<T> | undefined {
		let best: Job<T> | undefined;
		for (const job of this.queued) {
			if (job.source !== source) continue;
			if (
				!best ||
				job.priority < best.priority ||
				(job.priority === best.priority && job.seq < best.seq)
			) {
				best = job;
			}
		}
		return best;
	}

	private pump(source: string): void {
		let slots = this.running.get(source);
		if (!slots) {
			slots = new Set();
			this.running.set(source, slots);
		}
		for (;;) {
			const next = this.nextQueued(source);
			if (!next) return;
			if (slots.size >= this.maxPerSource) {
				// Make room when the most urgent waiting job beats the least urgent running one.
				let worst: Job<T> | undefined;
				for (const job of slots) {
					if (!worst || job.priority > worst.priority) worst = job;
				}
				if (!worst || worst.priority <= next.priority) return;
				worst.preempted = true;
				worst.controller?.abort();
				slots.delete(worst);
				worst.controller = null;
				this.queued.push(worst);
			}
			this.queued.splice(this.queued.indexOf(next), 1);
			this.start(next, slots);
		}
	}

	private start(job: Job<T>, slots: Set<Job<T>>): void {
		const controller = new AbortController();
		job.controller = controller;
		job.preempted = false;
		slots.add(job);
		const finish = () => {
			if (job.controller === controller) {
				slots.delete(job);
				job.controller = null;
			}
		};
		job.run(controller.signal).then(
			(value) => {
				if (controller.signal.aborted) return; // preempted: runs again later
				finish();
				this.jobs.delete(job.key);
				job.resolve(value);
				this.pump(job.source);
			},
			(error) => {
				if (controller.signal.aborted) return;
				finish();
				this.jobs.delete(job.key);
				job.reject(error);
				this.pump(job.source);
			}
		);
	}
}
