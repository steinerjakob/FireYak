import type maplibregl from 'maplibre-gl';
import type { GeoPoint } from '@/types/geo';

/**
 * Fast, offline-capable "is there water under the pin?" check against the
 * Protomaps `water` layer (plan §B2).
 *
 * Protomaps water polygons carry `kind` / `kind_detail` but **no OSM id** and
 * no name, and nearby polygons are merged — so this can never tell *which* OSM
 * object to tag. It only decides whether the Overpass water-area lookup is
 * worth running, suggests the pond type, and flags large/flowing water early.
 */

/** Protomaps style layer id of the water fill (`@protomaps/basemaps` v4+). */
const WATER_FILL_LAYER_ID = 'water';
/** Pixel radius around the pin that still counts as "next to the water". */
const NEAR_PIXELS = 14;

/**
 * How Protomaps (`layers/Water.java`) encodes water polygons — this is why
 * size, not `kind`, decides pond vs. lake:
 * - `natural=water` → `kind=water`; `landuse=reservoir` → `kind=lake`;
 *   `landuse=basin` → `kind=basin`.
 * - `water=pond|reservoir|lake|lagoon|oxbow|wastewater` all become
 *   `kind_detail=lake` — a 300 m² fire pond and a lake look identical.
 * - `water=river|stream|canal|ditch|drain` keep their value in `kind_detail`.
 */
const FLOWING_DETAILS = ['river', 'stream', 'canal', 'ditch', 'drain'];
/** `kind` values that are never a fire pond. */
const NEVER_POND_KINDS = [
	'ocean',
	'sea',
	'riverbank',
	'swimming_pool',
	'fountain',
	'dock',
	'playa',
	'reef'
];
/**
 * Above this polygon area (m²) the water is treated as "large" — suggest a
 * suction point instead (plan §D). ~2 ha.
 */
const LARGE_WATER_M2 = 20_000;

export interface WaterDetection {
	/**
	 * `water`: a water polygon is under or right next to the pin.
	 * `none`: the water layer is rendered here and has nothing near the pin.
	 * `unknown`: the layer is not available (style not loaded, layer missing) —
	 * callers must not skip the Overpass lookup on this.
	 */
	status: 'water' | 'none' | 'unknown';
	/** Protomaps `kind`, e.g. `water`, `lake`, `basin`. */
	kind?: string;
	/** Protomaps `kind_detail`, e.g. `lake` (also used for ponds) or `river`. */
	kindDetail?: string;
	/** Rough polygon area in m² (tile-clipped, so large lakes are underestimated). */
	areaM2?: number;
	/** True when the water could be a pond (suggest the fire-pond type). */
	pondLike: boolean;
	/** True for large or flowing water (suggest a suction point instead). */
	large: boolean;
}

const UNKNOWN: WaterDetection = { status: 'unknown', pondLike: false, large: false };

/**
 * Queries the rendered Protomaps water polygons at `location`.
 *
 * Uses `queryRenderedFeatures`, so it works from whatever tiles are on screen —
 * including offline tiles from a downloaded area. A polygon exactly under the
 * pin wins over one that is only within {@link NEAR_PIXELS}.
 */
export function detectWaterAt(map: maplibregl.Map, location: GeoPoint): WaterDetection {
	if (!map.isStyleLoaded() || !map.getLayer(WATER_FILL_LAYER_ID)) return UNKNOWN;

	const point = map.project([location.lng, location.lat]);
	// Off-screen pins have no rendered tiles to query — "no water" would be a lie.
	const canvas = map.getCanvas();
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return UNKNOWN;

	let features: maplibregl.MapGeoJSONFeature[];
	try {
		features = map.queryRenderedFeatures(point, { layers: [WATER_FILL_LAYER_ID] });
		if (features.length === 0) {
			features = map.queryRenderedFeatures(
				[
					[point.x - NEAR_PIXELS, point.y - NEAR_PIXELS],
					[point.x + NEAR_PIXELS, point.y + NEAR_PIXELS]
				],
				{ layers: [WATER_FILL_LAYER_ID] }
			);
		}
	} catch {
		return UNKNOWN;
	}

	if (features.length === 0) return { status: 'none', pondLike: false, large: false };

	// Several polygons can match (a pond next to a river, tile-split pieces);
	// prefer the smallest standing water, since that is the pond candidate.
	const described = features.map((f) => describe(f));
	const pick =
		described
			.filter((d) => d.pondLike)
			.sort((a, b) => (a.areaM2 ?? Infinity) - (b.areaM2 ?? Infinity))[0] ?? described[0];
	return pick;
}

function describe(feature: maplibregl.MapGeoJSONFeature): WaterDetection {
	const kind = feature.properties?.kind as string | undefined;
	const kindDetail = feature.properties?.kind_detail as string | undefined;
	const areaM2 = polygonAreaM2(feature.geometry);
	const flowing = FLOWING_DETAILS.includes(kindDetail ?? '');
	const neverPond = NEVER_POND_KINDS.includes(kind ?? '');
	const large = flowing || kind === 'ocean' || kind === 'sea' || (areaM2 ?? 0) > LARGE_WATER_M2;
	return {
		status: 'water',
		kind,
		kindDetail,
		areaM2,
		pondLike: !flowing && !neverPond && !large,
		large
	};
}

/** Approximate area (m²) of a lng/lat (Multi)Polygon, outer rings minus holes. */
function polygonAreaM2(geometry: GeoJSON.Geometry): number | undefined {
	const polygons =
		geometry.type === 'Polygon'
			? [geometry.coordinates]
			: geometry.type === 'MultiPolygon'
				? geometry.coordinates
				: null;
	if (!polygons) return undefined;
	let total = 0;
	for (const rings of polygons) {
		rings.forEach((ring, i) => {
			const a = ringAreaM2(ring);
			total += i === 0 ? a : -a;
		});
	}
	return Math.max(0, total);
}

/** Shoelace area of a ring after an equirectangular projection around its first point. */
function ringAreaM2(ring: GeoJSON.Position[]): number {
	if (ring.length < 3) return 0;
	const rad = Math.PI / 180;
	const lat0 = ring[0][1] * rad;
	const kx = 6_371_000 * Math.cos(lat0) * rad;
	const ky = 6_371_000 * rad;
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += ring[j][0] * kx * (ring[i][1] * ky) - ring[i][0] * kx * (ring[j][1] * ky);
	}
	return Math.abs(sum) / 2;
}
