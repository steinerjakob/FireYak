/**
 * The non-blocking contract of hose routing (plan §6.9): a request may wait
 * for remote tiles (basemap, DEM) only within one shared time budget; after
 * that it routes on what it has. The budget is an `AbortSignal` that fires at
 * the deadline. Tile fetchers read it in two ways:
 *
 * - while it is not aborted, the wait for a tile ends at the deadline
 *   ({@link budgetedFetch} races it), but the fetch itself is NOT cancelled: the
 *   main thread writes the late tile to the routing cache and reports it
 *   (`routingDataArrived`);
 * - once it is aborted, a fetcher answers from local stores only (downloaded
 *   areas, routing cache) and may start a background fetch for next time.
 *
 * No I/O; runs on the main thread, in the routing worker and in Node.
 */

/** Total wait for remote routing data per request (basemap, slope DEM, profile DEM). */
export const ROUTING_DATA_BUDGET_MS = 1500;

/** Fetches a tile's bytes; `null` = unavailable. An aborted `signal` means "local only". */
export type BudgetedTileFetcher = (
	source: string,
	z: number,
	x: number,
	y: number,
	signal?: AbortSignal
) => Promise<ArrayBuffer | null>;

export interface RoutingBudget {
	/** Aborts at the deadline. */
	signal: AbortSignal;
	/** Clears the timer (call when the request is done). */
	dispose(): void;
}

/** A budget of `ms` starting now. */
export function createBudget(ms = ROUTING_DATA_BUDGET_MS): RoutingBudget {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/**
 * `promise`, or `fallback` as soon as `signal` aborts (whichever comes first).
 * The promise keeps running; a later rejection is swallowed.
 */
export function untilAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	fallback: T
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		promise.catch(() => undefined);
		return Promise.resolve(fallback);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			promise.catch(() => undefined);
			resolve(fallback);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
}

/**
 * A tile fetch within the budget: before the deadline the wait is raced
 * against it (`null` at the deadline); after it the fetcher is called with the
 * aborted signal and trusted to answer from local stores only.
 */
export function budgetedFetch(
	fetcher: BudgetedTileFetcher,
	source: string,
	z: number,
	x: number,
	y: number,
	signal: AbortSignal | undefined
): Promise<ArrayBuffer | null> {
	if (!signal || signal.aborted) return fetcher(source, z, x, y, signal);
	return untilAborted(fetcher(source, z, x, y, signal), signal, null);
}

/** Resolves when `signal` aborts (never without one). */
export function whenAborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal) return;
		if (signal.aborted) return resolve();
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}
