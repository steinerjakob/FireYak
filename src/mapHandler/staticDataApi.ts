/**
 * Static FlatGeobuf read path (§4.3–§4.4 of `plans/selfhost-osm-data.md`).
 *
 * Replaces Overpass as the primary source for viewport marker reads: a bbox
 * range-read against the self-published `water_sources.fgb` extract, served
 * from Cloudflare R2 with CORS enabled for the app's web and native origins.
 * Overpass (`overPassApi.ts`) stays in place for single-node reads (§4.7) and
 * is untouched here.
 */
import { deserialize } from 'flatgeobuf/lib/mjs/geojson';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoBounds } from '@/types/geo';
import { OsmType } from '@/helper/osmRef';

const BASE = import.meta.env.VITE_DATA_BASE_URL ?? 'https://data.fireyak.org/fireyak-data';
export const FGB_URL = `${BASE}/water_sources.fgb`;
export const META_URL = `${BASE}/metadata.json`;

/** Shape of `metadata.json` as published by the pipeline. */
export interface DataMetadata {
	planet_timestamp: string;
	feature_count: number;
}

// ---------------------------------------------------------------------------
// @id → { type, id } — tolerant of both pipeline export formats
// ---------------------------------------------------------------------------

/**
 * Module-level flag so the "extract lacks type info" warning fires once per
 * session rather than once per feature — the fallback below can otherwise run
 * thousands of times for a single bbox read.
 */
let warnedMissingTypeInfo = false;

/** Warns once per session that the extract carries no element type. */
function warnMissingTypeInfoOnce(): void {
	if (warnedMissingTypeInfo) return;
	warnedMissingTypeInfo = true;
	console.warn(
		'[staticDataApi] water_sources.fgb carries no OSM element type: no "@type" ' +
			'property and "@id" is a bare number — falling back to inferring the type ' +
			'from geometry (Point → node, else → way), which mislabels relations as ways. ' +
			"The pipeline's export-config.json already sets attributes.type = true, so " +
			'this means the running image predates that config: rebuild the Docker image ' +
			'(the config is COPYed to /etc/osmium-export-config.json at build time, not ' +
			'read at run time) and re-run the pipeline.'
	);
}

/** Maps osmium's `@type` attribute value onto an {@link OsmType}. */
const OSM_TYPE_BY_NAME: Record<string, OsmType> = {
	node: 'node',
	way: 'way',
	relation: 'relation'
};

/**
 * Resolves a feature's numeric id and OSM element type, accepting every shape
 * the pipeline can produce, most authoritative first:
 *
 * 1. **`@type` + numeric `@id`** — what `export-config.json`'s
 *    `attributes.type = true` produces, and the preferred form: the type is
 *    explicit and `@id` stays a number, so nothing has to be parsed.
 * 2. **Typed string `@id`** (`"n123"` / `"w456"` / `"r789"`) — what
 *    `osmium export --add-unique-id=type_id` produces, supported so either
 *    pipeline configuration works.
 * 3. **Bare numeric `@id` with no type at all** — infers the type from the
 *    geometry (`Point` → node, anything else → way) and warns once per session.
 *    Transitional and lossy: relations are mislabelled as ways. Remove this
 *    branch once every published extract carries the type.
 *
 * Returns `null` if `@id` is missing or unusable.
 */
function resolveIdAndType(
	rawId: unknown,
	rawType: unknown,
	geometry: GeoJSON.Geometry | null
): { id: number; type: OsmType } | null {
	// (1) Explicit `@type` alongside the id — preferred.
	const declaredType = typeof rawType === 'string' ? OSM_TYPE_BY_NAME[rawType] : undefined;

	// (2) Typed string id, e.g. "w456".
	if (typeof rawId === 'string') {
		const match = /^([nwr])(\d+)$/.exec(rawId);
		if (match) {
			const prefixed: OsmType = match[1] === 'n' ? 'node' : match[1] === 'w' ? 'way' : 'relation';
			return { id: Number(match[2]), type: declaredType ?? prefixed };
		}
	}

	const numericId = typeof rawId === 'number' ? rawId : Number(rawId);
	if (!Number.isFinite(numericId)) return null;

	if (declaredType) return { id: numericId, type: declaredType };

	// (3) No type information anywhere — infer it, lossily.
	warnMissingTypeInfoOnce();
	return { id: numericId, type: geometry?.type === 'Point' ? 'node' : 'way' };
}

// ---------------------------------------------------------------------------
// Geometry → coordinates
// ---------------------------------------------------------------------------

/** Averages the vertices of a single ring/line into one representative point. */
function averagePosition(
	positions: GeoJSON.Position[] | undefined
): { lat: number; lon: number } | null {
	if (!positions || positions.length === 0) return null;
	let sumLat = 0;
	let sumLon = 0;
	for (const position of positions) {
		sumLon += position[0];
		sumLat += position[1];
	}
	return { lat: sumLat / positions.length, lon: sumLon / positions.length };
}

/**
 * Reduces any GeoJSON geometry to a single representative `{ lat, lon }`.
 * `Point` returns its own coordinate; polygons/lines average their outer-ring
 * (or the whole line's) vertices; Multi* geometries use their first member.
 * Returns `null` when the geometry carries no usable coordinate.
 */
function representativePoint(geometry: GeoJSON.Geometry): { lat: number; lon: number } | null {
	switch (geometry.type) {
		case 'Point':
			return { lat: geometry.coordinates[1], lon: geometry.coordinates[0] };
		case 'Polygon':
			return averagePosition(geometry.coordinates[0]);
		case 'MultiPolygon':
			return averagePosition(geometry.coordinates[0]?.[0]);
		case 'LineString':
			return averagePosition(geometry.coordinates);
		case 'MultiLineString':
			return averagePosition(geometry.coordinates[0]);
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Feature → OverPassElement adapter
// ---------------------------------------------------------------------------

const META_PROPERTY_PREFIX = '@';

/**
 * Converts a single FlatGeobuf/GeoJSON feature into the app's
 * {@link OverPassElement} shape so it can flow through the existing
 * `storeMapNodes` → IndexedDB cache path unchanged. Returns `null` for
 * features that can't be resolved to a usable id/type or coordinate.
 *
 * Exported so the offline-area downloader (a later task) can reuse it.
 */
export function toOverPassElement(feature: GeoJSON.Feature): OverPassElement | null {
	const geometry = feature.geometry ?? null;
	if (!geometry) return null;

	const properties = (feature.properties ?? {}) as Record<string, unknown>;
	const resolved = resolveIdAndType(properties['@id'], properties['@type'], geometry);
	if (!resolved) return null;

	const point = representativePoint(geometry);
	if (!point) return null;

	const tags: Record<string, string> = {};
	for (const [key, value] of Object.entries(properties)) {
		if (key.startsWith(META_PROPERTY_PREFIX)) continue;
		if (value === null || value === undefined) continue;
		tags[key] = String(value);
	}

	const element: OverPassElement = {
		id: resolved.id,
		type: resolved.type,
		tags
	};

	if (geometry.type === 'Point') {
		element.lat = point.lat;
		element.lon = point.lon;
	} else {
		element.center = point;
	}

	return element;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches water-source features intersecting `bounds` from the static
 * FlatGeobuf extract via an HTTP range read, converting each to an
 * {@link OverPassElement}. Throws on network/parse failure — unlike
 * `fetchMarkerData`, which returns `null` — so callers must catch explicitly
 * (see `markerHandler.ts`'s `updateNodeCache`).
 */
export async function fetchWaterSources(bounds: GeoBounds): Promise<OverPassElement[]> {
	const out: OverPassElement[] = [];
	for await (const feature of deserialize(FGB_URL, {
		minX: bounds.west,
		minY: bounds.south,
		maxX: bounds.east,
		maxY: bounds.north
	})) {
		const element = toOverPassElement(feature as GeoJSON.Feature);
		if (element) out.push(element);
	}
	return out;
}

/**
 * Fetches the published `metadata.json` (planet timestamp + feature count).
 * Returns `null` on any failure — callers should fall back to a cached value
 * (see §4.9; not wired up in this change).
 */
export async function fetchDataMetadata(): Promise<DataMetadata | null> {
	try {
		const response = await fetch(META_URL);
		if (!response.ok) return null;
		return (await response.json()) as DataMetadata;
	} catch (e) {
		console.error('Error fetching data metadata:', e);
		return null;
	}
}

/**
 * Process-wide memo of {@link fetchDataMetadata}. The extract is rebuilt every
 * couple of days, so re-fetching it per bbox read would be pure waste. A failed
 * lookup is not memoized, so a request made while offline can succeed later.
 */
let metadataPromise: Promise<DataMetadata | null> | null = null;

export function getDataMetadata(): Promise<DataMetadata | null> {
	if (!metadataPromise) {
		metadataPromise = fetchDataMetadata().then((meta) => {
			if (!meta) metadataPromise = null;
			return meta;
		});
	}
	return metadataPromise;
}

/**
 * The extract's planet timestamp in epoch-ms, or `null` when it can't be
 * determined. This is the cut-off the extract can legitimately speak about:
 * it knows nothing about objects created after it was built, so its silence
 * about them is not evidence of deletion (see `reconcileDeletedNodes`).
 */
export async function getExtractTimestampMs(): Promise<number | null> {
	const meta = await getDataMetadata();
	if (!meta?.planet_timestamp) return null;
	const parsed = Date.parse(meta.planet_timestamp);
	return Number.isNaN(parsed) ? null : parsed;
}
