import type { GeoPoint } from '@/types/geo';
import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import { decodeTerrariumImage } from '@/helper/demTiles';
import {
	RoutingCancelledError,
	configureRoutingIO,
	invalidateRoutingContext as invalidateInlineContext,
	isRoutingCancelled,
	routeNearby,
	routePath,
	type HoseRoute,
	type NearbyDistanceResult,
	type NearbyRoutingOptions,
	type RouteTargetInput,
	type RoutingOptions
} from '@/mapHandler/hoseRoutingCore';
import { HoseRoutingClient } from '@/mapHandler/hoseRoutingProtocol';

/**
 * Main-thread facade of hose routing (plan §6.10): the nearby list, the
 * marker path and the pump line ask here. The solve runs in the hose routing
 * worker (`src/workers/hoseRouting.worker.ts`); this side fetches the tile
 * bytes cache-first through the `offline://` pipeline (the native tile store
 * is not reachable from a worker) and transfers them. Where a worker cannot
 * start (no `Worker`, a WebView that refuses it, no answer within
 * {@link WORKER_READY_TIMEOUT_MS}) or fails later, the same solve
 * (`hoseRoutingCore.ts`) runs on the main thread instead.
 *
 * A request may name a `channel`: a newer request on the same channel
 * supersedes the running one, which rejects with
 * {@link RoutingCancelledError} (callers drop it silently).
 */

export {
	MAX_ROUTED_TARGETS,
	PATH_MAX_STRAIGHT_M,
	POND_SHORE_SAMPLE_M,
	ROUTING_MAX_STRAIGHT_M,
	RoutingCancelledError,
	chooseCellSize,
	isRoutingCancelled,
	type HoseRoute,
	type HoseRoutingMode,
	type NearbyDistanceResult,
	type NearbyRoutingOptions,
	type RouteFallback,
	type RouteTargetInput,
	type RoutingCoverage,
	type RoutingOptions
} from '@/mapHandler/hoseRoutingCore';

/** How long the worker may take to answer `ready` before the main thread routes itself. */
export const WORKER_READY_TIMEOUT_MS = 5000;

/** Where a request runs; `auto` = the worker when it starts, else inline. */
export type RoutingBackendChoice = 'auto' | 'inline';

/** Request handling beyond the routing options. */
export interface RoutingRequest {
	/** Supersession key: a newer request on the same channel cancels this one. */
	channel?: string;
}

type Backend = { kind: 'worker'; client: HoseRoutingClient; worker: Worker } | { kind: 'inline' };

let backend: Promise<Backend> | null = null;
let inlineConfigured = false;
/** The inline runs per channel, so a newer request can cancel the older one. */
const inlineChannels = new Map<string, { controller: AbortController; cancel: () => void }>();

function inlineBackend(): Backend {
	if (!inlineConfigured) {
		// Keeps the realm's DEM decoder (the browser's, or a spec's WASM one).
		configureRoutingIO({ fetchTile: fetchTileCacheFirst });
		inlineConfigured = true;
	}
	return { kind: 'inline' };
}

/** `VITE_HOSE_ROUTING_WORKER=0` (dev/measurement only) keeps routing on the main thread. */
const workerDisabled = import.meta.env.VITE_HOSE_ROUTING_WORKER === '0';

async function startWorker(): Promise<Backend> {
	if (typeof Worker === 'undefined' || workerDisabled) return inlineBackend();
	let worker: Worker | null = null;
	try {
		worker = new Worker(new URL('../workers/hoseRouting.worker.ts', import.meta.url), {
			type: 'module',
			name: 'hose-routing'
		});
		const client = new HoseRoutingClient(worker, {
			fetchTile: fetchTileCacheFirst,
			decodeDem: decodeTerrariumImage
		});
		const started = worker;
		started.onerror = (event) => {
			console.warn('Hose routing worker failed, routing on the main thread:', event.message);
			event.preventDefault?.();
			client.failAll(new Error('Hose routing worker failed'));
			started.terminate();
			backend = Promise.resolve(inlineBackend());
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('no ready message')), WORKER_READY_TIMEOUT_MS);
		});
		try {
			const { demDecode } = await Promise.race([client.ready, timeout]);
			if (!demDecode)
				console.info('Hose routing worker: DEM images are decoded on the main thread');
		} finally {
			clearTimeout(timer);
		}
		return { kind: 'worker', client, worker };
	} catch (e) {
		console.warn('Hose routing worker unavailable, routing on the main thread:', e);
		worker?.terminate();
		return inlineBackend();
	}
}

function getBackend(): Promise<Backend> {
	backend ??= startWorker();
	return backend;
}

/**
 * Chooses where routing runs: `inline` (main thread; the debug view's
 * comparison and the Node specs) or `auto` (the worker when it starts). Drops
 * a running worker.
 */
export function setRoutingBackend(choice: RoutingBackendChoice): void {
	void backend?.then((b) => {
		if (b.kind === 'worker') {
			b.client.failAll(new RoutingCancelledError('Routing backend changed'));
			b.worker.terminate();
		}
	});
	backend = choice === 'inline' ? Promise.resolve(inlineBackend()) : null;
}

/** Which backend serves the requests (debug view). */
export async function routingBackendKind(): Promise<'worker' | 'inline'> {
	return (await getBackend()).kind;
}

/**
 * Runs `solve` on the main thread; with a channel, a newer inline request on
 * it aborts this one (at its next await) and rejects its promise at once.
 */
function runInline<T>(channel: string | undefined, solve: (signal: AbortSignal) => Promise<T>) {
	const controller = new AbortController();
	if (channel === undefined) return solve(controller.signal);
	inlineChannels.get(channel)?.cancel();
	return new Promise<T>((resolve, reject) => {
		const entry = {
			controller,
			cancel: () => {
				controller.abort();
				reject(new RoutingCancelledError('Routing request superseded'));
			}
		};
		inlineChannels.set(channel, entry);
		solve(controller.signal)
			.then(resolve, reject)
			.finally(() => {
				if (inlineChannels.get(channel) === entry) inlineChannels.delete(channel);
			});
	});
}

/**
 * Runs a request in the worker, or inline; a worker failure (not a
 * cancellation) retries it inline once.
 */
async function dispatch<T>(
	channel: string | undefined,
	inWorker: (client: HoseRoutingClient) => Promise<T>,
	inline: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	const b = await getBackend();
	if (b.kind === 'inline') return runInline(channel, inline);
	try {
		return await inWorker(b.client);
	} catch (e) {
		if (isRoutingCancelled(e)) throw e;
		console.warn('Hose routing worker request failed, routing on the main thread:', e);
		inlineBackend();
		return runInline(channel, inline);
	}
}

/**
 * Computes the routed distances (and routes) for the nearby list (see
 * `routeNearby` in `hoseRoutingCore.ts`). Rejects only with
 * {@link RoutingCancelledError} when superseded on its channel.
 */
export function computeNearbyDistances(
	origin: GeoPoint,
	targets: RouteTargetInput[],
	straightDistances: number[],
	options: NearbyRoutingOptions = { mode: 'optimized' },
	request: RoutingRequest = {}
): Promise<NearbyDistanceResult[]> {
	return dispatch(
		request.channel,
		(client) => client.nearby(origin, targets, straightDistances, options, request.channel),
		(signal) => routeNearby(origin, targets, straightDistances, options, signal)
	);
}

/**
 * Routed display line `origin` → `target` (see `routePath` in
 * `hoseRoutingCore.ts`). Never `null`; rejects only with
 * {@link RoutingCancelledError} when superseded on its channel.
 */
export function getRoutedPath(
	origin: GeoPoint,
	target: RouteTargetInput,
	options: RoutingOptions = { mode: 'optimized' },
	request: RoutingRequest = {}
): Promise<HoseRoute> {
	return dispatch(
		request.channel,
		(client) => client.path(origin, target, options, request.channel),
		(signal) => routePath(origin, target, options, signal)
	);
}

/** Drops the cached routing context in the worker and on the main thread (tuning/testing). */
export function invalidateRoutingContext(): void {
	invalidateInlineContext();
	void backend?.then((b) => {
		if (b.kind === 'worker') b.client.invalidate();
	});
}
