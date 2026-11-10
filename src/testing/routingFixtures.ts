import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js';
import type { GeoPoint } from '@/types/geo';
import { terrariumToElevations } from '@/helper/demRaster';

/**
 * Test-only helpers for the routing fixtures in
 * `src/mapHandler/__fixtures__/routing/` (see the README there). App code must
 * not import this module (eslint `no-restricted-imports`).
 */

export const FIXTURE_ROOT = fileURLToPath(
	new URL('../mapHandler/__fixtures__/routing/', import.meta.url)
);

/** Inclusive x/y tile range at one zoom, as written in `scene.json`. */
export interface SceneTileRange {
	z: number;
	x: [number, number];
	y: [number, number];
}

export interface SceneRing {
	/** Nominal ring radius around the anchor in meters. */
	radius: number;
	/** Nominal bearing in degrees clockwise from north. */
	bearing: number;
	/** Vehicle position, already moved to the nearest road. */
	vehicle: GeoPoint;
	/** How far the nominal position was moved to reach the road (meters). */
	movedM?: number;
	/** Straight-line distance vehicle → anchor in meters. */
	straightM: number;
	/** Protomaps `kind/kind_detail` of the road the vehicle sits on. */
	vehicleKind: string;
}

export interface SceneCase {
	label: string;
	/** Vehicle / origin. */
	from: GeoPoint;
	/** Water source / target. */
	to: GeoPoint;
	straightM?: number;
}

export interface RoutingScene {
	id: string;
	name: string;
	fetched: string;
	anchor: GeoPoint & { label: string };
	tiles: { basemap: SceneTileRange; dem: SceneTileRange[] };
	cases?: Record<string, SceneCase>;
	/** 16 bearings x 150/300/500 m around the anchor (vehicle within 60 m of a road). */
	rings?: SceneRing[];
	/** Innsbruck only: relaxed placement (150 m, tracks allowed). */
	ringsRelaxed?: SceneRing[];
	/** Scene 1: the pond outline (OSM relation 7228761: outer ring, then the island). */
	pond?: GeoJSON.Polygon;
}

export type TileFetcher = (
	source: string,
	z: number,
	x: number,
	y: number,
	signal?: AbortSignal
) => Promise<ArrayBuffer | null>;

/** Ids of every scene folder, sorted. */
export const SCENE_IDS: string[] = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

export function loadScene(id: string): RoutingScene {
	return JSON.parse(readFileSync(join(FIXTURE_ROOT, id, 'scene.json'), 'utf8')) as RoutingScene;
}

/** Every tile of a range, in x-major order. */
export function tilesOfRange(range: SceneTileRange): { z: number; x: number; y: number }[] {
	const tiles: { z: number; x: number; y: number }[] = [];
	for (let x = range.x[0]; x <= range.x[1]; x++) {
		for (let y = range.y[0]; y <= range.y[1]; y++) tiles.push({ z: range.z, x, y });
	}
	return tiles;
}

/** Path of a fixture tile; `source` is the app's source name (`protomaps` or `terrain`). */
export function tilePath(sceneId: string, source: string, z: number, x: number, y: number): string {
	const kind = source === 'protomaps' ? 'basemap' : 'dem';
	const ext = source === 'protomaps' ? 'mvt' : 'webp';
	return join(FIXTURE_ROOT, sceneId, kind, String(z), String(x), `${y}.${ext}`);
}

/** All tile files a scene lists. */
export function sceneTileFiles(scene: RoutingScene): string[] {
	return [
		...tilesOfRange(scene.tiles.basemap).map((t) => tilePath(scene.id, 'protomaps', t.z, t.x, t.y)),
		...scene.tiles.dem.flatMap((range) =>
			tilesOfRange(range).map((t) => tilePath(scene.id, 'terrain', t.z, t.x, t.y))
		)
	];
}

/** True when every tile of every scene is on disk (the gitignored tiles are fetched locally). */
export const fixturesPresent: boolean =
	SCENE_IDS.length > 0 &&
	SCENE_IDS.every((id) => sceneTileFiles(loadScene(id)).every((file) => existsSync(file)));

/** Total size of the fixture folder in bytes. */
export function fixtureBytes(dir: string = FIXTURE_ROOT): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		total += entry.isDirectory() ? fixtureBytes(path) : statSync(path).size;
	}
	return total;
}

/**
 * A `TileFetcher` serving one scene's tiles from disk. Unknown or missing tiles
 * yield `null`, like an offline gap.
 */
export function fixtureFetcher(scene: RoutingScene): TileFetcher {
	return async (source, z, x, y) => {
		const file = tilePath(scene.id, source, z, x, y);
		if (!existsSync(file)) return null;
		const bytes = readFileSync(file);
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	};
}

let activeFetcher: TileFetcher = async () => null;

/** Makes `fetchTileCacheFirst` (mocked in scene specs) serve `scene`'s tiles. */
export function useFixtureScene(scene: RoutingScene): void {
	activeFetcher = fixtureFetcher(scene);
}

/** Delegating fetcher for `vi.mock('@/offline/offlineProtocol', …)` factories. */
export const activeSceneFetcher: TileFetcher = (...args) => activeFetcher(...args);

/** Names of the vector layers inside an MVT tile. */
export function mvtLayerNames(buffer: ArrayBuffer): string[] {
	return Object.keys(new VectorTile(new PbfReader(buffer)).layers);
}

export interface DecodedDemTile {
	size: number;
	/** Row-major elevations in meters. */
	elevations: Float32Array;
}

let webpReady: Promise<void> | null = null;

/**
 * Decodes a terrarium WebP tile in Node (`@jsquash/webp`, WASM; `createImageBitmap`
 * and canvas do not exist there). The decoder's package entry also loads the
 * encoder, which needs a newer Node syntax than 22, so the decode module is
 * imported directly and the WASM is handed in from disk.
 */
export async function decodeDemWebp(buffer: ArrayBuffer): Promise<DecodedDemTile> {
	webpReady ??= (async () => {
		const wasm = readFileSync(
			createRequire(import.meta.url).resolve('@jsquash/webp/codec/dec/webp_dec.wasm')
		);
		await initWebp(await WebAssembly.compile(wasm));
	})();
	await webpReady;
	const image = await decodeWebp(buffer);
	const size = image.width;
	return { size, elevations: terrariumToElevations(image.data, size * image.height) };
}
