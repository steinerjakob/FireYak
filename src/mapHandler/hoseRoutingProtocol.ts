import type { GeoPoint } from '@/types/geo';
import type { DecodedDemTile } from '@/helper/demRaster';
import { decodeTerrariumImage, type DemTileDecoder } from '@/helper/demTiles';
import type { TileFetcher } from '@/mapHandler/obstacleTiles';
import {
	RoutingCancelledError,
	configureRoutingIO,
	invalidateRoutingContext,
	isRoutingCancelled,
	routeNearby,
	routePath,
	type HoseRoute,
	type NearbyDistanceResult,
	type NearbyRoutingOptions,
	type RouteTargetInput,
	type RoutingOptions
} from '@/mapHandler/hoseRoutingCore';

/**
 * Message protocol between the main thread and the hose routing worker (plan
 * §6.10). Both ends live here so they cannot drift apart:
 *
 * - {@link serveHoseRouting} runs in the worker (`hoseRouting.worker.ts`): it
 *   answers list and single-path requests with the pure solve of
 *   `hoseRoutingCore.ts`, keeping the routing context and the decode LRUs.
 * - {@link HoseRoutingClient} runs on the main thread (`nearbyRouting.ts`):
 *   it sends requests, cancels superseded ones, and serves the worker's tile
 *   requests through the cache-first `offline://` pipeline. Capacitor plugins
 *   (the native tile store on the Filesystem) are not reachable from a worker,
 *   so the main thread fetches the bytes and TRANSFERS the `ArrayBuffer`s.
 *
 * Where the worker has no `OffscreenCanvas`/`createImageBitmap` for WebP, it
 * asks the main thread to decode the DEM images (`decodeDem`) and gets the
 * elevations back as a transferred `Float32Array`.
 *
 * Every message is structured-cloneable; {@link transferablesOf} lists what a
 * message hands over instead of copying.
 */

/** Main thread → worker. */
export type ToWorkerMessage =
	| {
			type: 'nearby';
			id: number;
			origin: GeoPoint;
			targets: RouteTargetInput[];
			straightDistances: number[];
			options: NearbyRoutingOptions;
	  }
	| {
			type: 'path';
			id: number;
			origin: GeoPoint;
			target: RouteTargetInput;
			options: RoutingOptions;
	  }
	| { type: 'cancel'; id: number }
	| { type: 'invalidate' }
	/** Answer to {@link FromWorkerMessage} `fetchTile`; `null` = unavailable. */
	| { type: 'tile'; reqId: number; bytes: ArrayBuffer | null }
	/** Answer to {@link FromWorkerMessage} `decodeDem`; `null` = decode failed. */
	| { type: 'demDecoded'; reqId: number; tile: DecodedDemTile | null };

/** Worker → main thread. */
export type FromWorkerMessage =
	/** The worker is up; `demDecode` = it decodes WebP itself. */
	| { type: 'ready'; demDecode: boolean }
	/**
	 * Tile bytes. `localOnly`: the request's routing budget is spent, answer
	 * from the area store and the routing cache only (plan §6.9).
	 */
	| {
			type: 'fetchTile';
			reqId: number;
			source: string;
			z: number;
			x: number;
			y: number;
			localOnly?: boolean;
	  }
	| { type: 'decodeDem'; reqId: number; bytes: ArrayBuffer }
	| { type: 'result'; id: number; ok: true; value: NearbyDistanceResult[] | HoseRoute }
	| { type: 'result'; id: number; ok: false; cancelled: boolean; error: string };

/** The part of `Worker`, a worker's global scope and a `MessagePort` both ends use. */
export interface RoutingPort {
	postMessage(message: unknown, transfer: Transferable[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
}

/** The buffers a message hands over (moved, not copied); empty for the rest. */
export function transferablesOf(message: ToWorkerMessage | FromWorkerMessage): Transferable[] {
	switch (message.type) {
		case 'tile':
			return message.bytes ? [message.bytes] : [];
		case 'decodeDem':
			return [message.bytes];
		case 'demDecoded':
			return message.tile ? [message.tile.elevations.buffer as ArrayBuffer] : [];
		default:
			return [];
	}
}

function post(port: RoutingPort, message: ToWorkerMessage | FromWorkerMessage): void {
	port.postMessage(message, transferablesOf(message));
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/** A lossless 1×1 WebP: the probe for WebP decoding in this realm. */
const PROBE_WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

function base64ToBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

/**
 * True when this realm can decode the DEM WebP images itself
 * (`createImageBitmap` and a 2D `OffscreenCanvas`, tried on a 1×1 image).
 */
export async function canDecodeDemHere(): Promise<boolean> {
	if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
		return false;
	}
	try {
		const tile = await decodeTerrariumImage(base64ToBuffer(PROBE_WEBP));
		return tile.size === 1;
	} catch {
		return false;
	}
}

/** Options of {@link serveHoseRouting}. */
export interface ServeOptions {
	/** DEM decoder to use in the worker; default: the browser decoder when it works, else the main thread. */
	decodeDem?: DemTileDecoder;
}

/**
 * Answers routing requests on `port` (the worker's global scope). Tile bytes
 * are requested from the main thread; requests run concurrently (each awaits
 * its tiles), and a `cancel` aborts one at its next await.
 */
export function serveHoseRouting(port: RoutingPort, options: ServeOptions = {}): void {
	let nextReqId = 1;
	const waiting = new Map<number, (message: ToWorkerMessage) => void>();
	const running = new Map<number, AbortController>();

	const ask = (message: FromWorkerMessage & { reqId: number }) =>
		new Promise<ToWorkerMessage>((resolve) => {
			waiting.set(message.reqId, resolve);
			post(port, message);
		});
	// The routing core bounds the wait (budget); an already spent budget asks for local tiles only.
	const fetchTile: TileFetcher = async (source, z, x, y, signal) => {
		const answer = await ask({
			type: 'fetchTile',
			reqId: nextReqId++,
			source,
			z,
			x,
			y,
			localOnly: signal?.aborted === true
		});
		return answer.type === 'tile' ? answer.bytes : null;
	};
	const remoteDecode: DemTileDecoder = async (bytes) => {
		const answer = await ask({ type: 'decodeDem', reqId: nextReqId++, bytes });
		if (answer.type !== 'demDecoded' || !answer.tile) throw new Error('DEM decode failed');
		return answer.tile;
	};

	const ready = (async () => {
		let decodeDem = options.decodeDem;
		let demDecode = true;
		if (!decodeDem) {
			demDecode = await canDecodeDemHere();
			decodeDem = demDecode ? decodeTerrariumImage : remoteDecode;
		}
		configureRoutingIO({ fetchTile, decodeDem });
		post(port, { type: 'ready', demDecode });
	})();

	const run = async (id: number, solve: (signal: AbortSignal) => Promise<unknown>) => {
		const controller = new AbortController();
		running.set(id, controller);
		try {
			await ready;
			const value = (await solve(controller.signal)) as NearbyDistanceResult[] | HoseRoute;
			if (controller.signal.aborted) throw new RoutingCancelledError();
			post(port, { type: 'result', id, ok: true, value });
		} catch (e) {
			post(port, {
				type: 'result',
				id,
				ok: false,
				cancelled: isRoutingCancelled(e),
				error: e instanceof Error ? e.message : String(e)
			});
		} finally {
			running.delete(id);
		}
	};

	port.onmessage = (event: MessageEvent) => {
		const message = event.data as ToWorkerMessage;
		switch (message.type) {
			case 'nearby':
				void run(message.id, (signal) =>
					routeNearby(
						message.origin,
						message.targets,
						message.straightDistances,
						message.options,
						signal
					)
				);
				break;
			case 'path':
				void run(message.id, (signal) =>
					routePath(message.origin, message.target, message.options, signal)
				);
				break;
			case 'cancel':
				running.get(message.id)?.abort();
				break;
			case 'invalidate':
				invalidateRoutingContext();
				break;
			case 'tile':
			case 'demDecoded': {
				const resolve = waiting.get(message.reqId);
				waiting.delete(message.reqId);
				resolve?.(message);
				break;
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Main-thread side
// ---------------------------------------------------------------------------

/** The main thread's I/O for the worker: tile bytes and (fallback) DEM decode. */
export interface ClientIO {
	fetchTile: TileFetcher;
	decodeDem: DemTileDecoder;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	channel?: string;
}

/**
 * Main-thread end of the protocol. A request may name a `channel`: a newer
 * request on the same channel supersedes the older one, which is cancelled in
 * the worker and rejects at once with {@link RoutingCancelledError} (a
 * location update makes the running list search stale).
 */
export class HoseRoutingClient {
	/** Resolves once the worker answered `ready`. */
	readonly ready: Promise<{ demDecode: boolean }>;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly channels = new Map<string, number>();
	private markReady!: (value: { demDecode: boolean }) => void;

	constructor(
		private readonly port: RoutingPort,
		private readonly io: ClientIO
	) {
		this.ready = new Promise((resolve) => {
			this.markReady = resolve;
		});
		port.onmessage = (event: MessageEvent) => this.receive(event.data as FromWorkerMessage);
	}

	/** The nearby list (see `routeNearby` in `hoseRoutingCore.ts`). */
	nearby(
		origin: GeoPoint,
		targets: RouteTargetInput[],
		straightDistances: number[],
		options: NearbyRoutingOptions,
		channel?: string
	): Promise<NearbyDistanceResult[]> {
		const id = this.nextId++;
		return this.request(
			{ type: 'nearby', id, origin, targets, straightDistances, options },
			channel
		) as Promise<NearbyDistanceResult[]>;
	}

	/** One path (see `routePath` in `hoseRoutingCore.ts`). */
	path(
		origin: GeoPoint,
		target: RouteTargetInput,
		options: RoutingOptions,
		channel?: string
	): Promise<HoseRoute> {
		const id = this.nextId++;
		return this.request(
			{ type: 'path', id, origin, target, options },
			channel
		) as Promise<HoseRoute>;
	}

	/** Drops the worker's routing context. */
	invalidate(): void {
		post(this.port, { type: 'invalidate' });
	}

	/** Rejects every pending request (the worker failed); callers may retry elsewhere. */
	failAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(error);
		}
		this.channels.clear();
	}

	/** Number of requests still waiting for an answer (specs). */
	get pendingCount(): number {
		return this.pending.size;
	}

	private request(
		message: ToWorkerMessage & { id: number },
		channel: string | undefined
	): Promise<unknown> {
		if (channel !== undefined) {
			const previous = this.channels.get(channel);
			if (previous !== undefined) this.cancel(previous, 'superseded');
			this.channels.set(channel, message.id);
		}
		return new Promise((resolve, reject) => {
			this.pending.set(message.id, { resolve, reject, channel });
			post(this.port, message);
		});
	}

	private cancel(id: number, reason: string): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.settle(id);
		post(this.port, { type: 'cancel', id });
		pending.reject(new RoutingCancelledError(`Routing request ${reason}`));
	}

	/** Forgets request `id` (and its channel slot). */
	private settle(id: number): Pending | undefined {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		if (pending?.channel !== undefined && this.channels.get(pending.channel) === id) {
			this.channels.delete(pending.channel);
		}
		return pending;
	}

	private receive(message: FromWorkerMessage): void {
		switch (message.type) {
			case 'ready':
				this.markReady({ demDecode: message.demDecode });
				break;
			case 'fetchTile':
				void this.io
					.fetchTile(
						message.source,
						message.z,
						message.x,
						message.y,
						message.localOnly ? AbortSignal.abort() : undefined
					)
					.catch(() => null)
					.then((bytes) =>
						post(this.port, {
							type: 'tile',
							reqId: message.reqId,
							bytes: bytes && bytes.byteLength > 0 ? bytes : null
						})
					);
				break;
			case 'decodeDem':
				void this.io
					.decodeDem(message.bytes)
					.catch(() => null)
					.then((tile) => post(this.port, { type: 'demDecoded', reqId: message.reqId, tile }));
				break;
			case 'result': {
				// A superseded request was already rejected; its late answer is dropped.
				const pending = this.settle(message.id);
				if (!pending) break;
				if (message.ok) pending.resolve(message.value);
				else if (message.cancelled) pending.reject(new RoutingCancelledError());
				else pending.reject(new Error(message.error));
				break;
			}
		}
	}
}
