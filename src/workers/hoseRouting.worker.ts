import { serveHoseRouting, type RoutingPort } from '@/mapHandler/hoseRoutingProtocol';

/**
 * The hose routing worker (plan §6.10): a thin shell around
 * `serveHoseRouting`. The solve (grid build, height raster, search,
 * smoothing) runs here with the same pure modules the main-thread fallback
 * uses; tile bytes come from the main thread (`nearbyRouting.ts`).
 */
serveHoseRouting(self as unknown as RoutingPort);
