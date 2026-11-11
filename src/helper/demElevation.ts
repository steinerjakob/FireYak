import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import { setDemTileFetcher } from '@/helper/demTiles';

/**
 * Main-thread entry to the Mapterhorn terrain DEM (`demTiles.ts`): tiles go
 * through the same cache-first pipeline as the map (`offline://terrain/...`),
 * so inside a downloaded area this works fully offline — the pump calculation
 * no longer needs the Open-Meteo API there. The hose routing worker has its
 * own copy of `demTiles.ts`, fed by the main thread (plan §6.10).
 */
setDemTileFetcher(fetchTileCacheFirst);

export * from '@/helper/demTiles';
