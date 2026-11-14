import type { GeoPoint } from '@/types/geo';

/**
 * Pure DEM raster helpers: terrarium decoding of RGBA pixels and bilinear
 * sampling **across** tile edges (plan §6.4, phase 1). Image decoding and
 * fetching stay in `demElevation.ts`; this module has no I/O so specs can run
 * it in Node.
 */

export interface DecodedDemTile {
	/** Edge length in pixels (Mapterhorn: 512). */
	size: number;
	/** Row-major elevations in metres. */
	elevations: Float32Array;
}

/** Elevations from RGBA pixels: terrarium `r*256 + g + b/256 - 32768`. */
export function terrariumToElevations(rgba: ArrayLike<number>, pixelCount: number): Float32Array {
	const elevations = new Float32Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) {
		const p = i * 4;
		elevations[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
	}
	return elevations;
}

/** Continuous web-mercator tile coordinate (tile index + in-tile fraction). */
export function pointToTileCoord(point: GeoPoint, z: number): { tx: number; ty: number } {
	const n = 2 ** z;
	const tx = ((point.lng + 180) / 360) * n;
	const latRad = (point.lat * Math.PI) / 180;
	const ty = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	return { tx, ty };
}

/** Tile key `x/y` used by the samplers. */
export function tileKey(x: number, y: number): string {
	return `${x}/${y}`;
}

/**
 * The four global pixel indexes (and weights) a bilinear sample at `point`
 * reads. Pixel centres sit at +0.5, so a point near a tile edge reads pixels
 * of the neighbouring tile.
 */
function bilinearPixels(point: GeoPoint, z: number, size: number) {
	const { tx, ty } = pointToTileCoord(point, z);
	const gx = tx * size - 0.5;
	const gy = ty * size - 0.5;
	const x0 = Math.floor(gx);
	const y0 = Math.floor(gy);
	return { x0, y0, dx: gx - x0, dy: gy - y0 };
}

/**
 * Keys of every tile a set of bilinear samples reads at zoom `z`, including
 * the neighbour tiles needed at tile edges.
 */
export function tilesForSamples(points: GeoPoint[], z: number, size = 512): Set<string> {
	const n = 2 ** z;
	const keys = new Set<string>();
	for (const point of points) {
		const { x0, y0 } = bilinearPixels(point, z, size);
		for (const px of [x0, x0 + 1]) {
			for (const py of [y0, y0 + 1]) {
				const x = Math.min(Math.max(Math.floor(px / size), 0), n - 1);
				const y = Math.min(Math.max(Math.floor(py / size), 0), n - 1);
				keys.add(tileKey(x, y));
			}
		}
	}
	return keys;
}

/**
 * Bilinear sampler over a set of decoded tiles at zoom `z`, taking continuous
 * tile coordinates (`tx`, `ty`, as {@link pointToTileCoord} returns them).
 * Pixels of a missing neighbour tile are replaced by the nearest pixel of the
 * tile the sample lies in (the old clamped behaviour), so a gap degrades
 * gracefully; `null` when that home tile is missing. Tiles are looked up in a
 * flat array over their key range, so a raster of 100k samples stays cheap.
 */
export function tileSampler(
	tiles: Map<string, DecodedDemTile>
): (tx: number, ty: number) => number | null {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	let size = 0;
	for (const [key, tile] of tiles) {
		const [x, y] = key.split('/').map(Number);
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
		size ||= tile.size;
	}
	if (size === 0) return () => null;
	const w = x1 - x0 + 1;
	const grid: (DecodedDemTile | undefined)[] = new Array(w * (y1 - y0 + 1));
	for (const [key, tile] of tiles) {
		const [x, y] = key.split('/').map(Number);
		if (tile.size === size) grid[(y - y0) * w + (x - x0)] = tile;
	}
	const get = (x: number, y: number) =>
		x < x0 || x > x1 || y < y0 || y > y1 ? undefined : grid[(y - y0) * w + (x - x0)];

	return (tx, ty) => {
		const homeX = Math.floor(tx);
		const homeY = Math.floor(ty);
		const home = get(homeX, homeY);
		if (!home) return null;
		const gx = tx * size - 0.5;
		const gy = ty * size - 0.5;
		const px0 = Math.floor(gx);
		const py0 = Math.floor(gy);
		const dx = gx - px0;
		const dy = gy - py0;
		const pixel = (px: number, py: number): number => {
			const x = Math.floor(px / size);
			const y = Math.floor(py / size);
			const tile = x === homeX && y === homeY ? home : get(x, y);
			if (tile) return tile.elevations[(py - y * size) * size + (px - x * size)];
			// Neighbour missing: clamp into the home tile.
			const lx = Math.min(Math.max(px - homeX * size, 0), size - 1);
			const ly = Math.min(Math.max(py - homeY * size, 0), size - 1);
			return home.elevations[ly * size + lx];
		};
		const top = pixel(px0, py0) * (1 - dx) + pixel(px0 + 1, py0) * dx;
		const bottom = pixel(px0, py0 + 1) * (1 - dx) + pixel(px0 + 1, py0 + 1) * dx;
		return top * (1 - dy) + bottom * dy;
	};
}

/**
 * Bilinear elevation at `point` from the decoded tiles in `tiles` (keyed by
 * {@link tileKey}); see {@link tileSampler} for missing tiles. Returns `null`
 * when the point's own tile is missing.
 */
export function sampleBlended(
	tiles: Map<string, DecodedDemTile>,
	point: GeoPoint,
	z: number
): number | null {
	const { tx, ty } = pointToTileCoord(point, z);
	return tileSampler(tiles)(tx, ty);
}

// ---------------------------------------------------------------------------
// Height raster for the cost grid (plan §6.4, phase 4)
// ---------------------------------------------------------------------------

/** Metres per degree of latitude (the value the cost grid uses). */
const M_PER_DEG_LAT = 110540;

/** Placement of a cost grid: cell (col, row) spans `west + col * cellM` ... (local metres). */
export interface RasterFrame {
	west: number;
	south: number;
	/** Metres per degree of longitude at the window's mid latitude. */
	mPerDegLng: number;
	cols: number;
	rows: number;
	cellM: number;
}

/**
 * Heights at the cell centres of a cost grid, with a one-cell halo on every
 * side: `heights[(row + 1) * (cols + 2) + (col + 1)]` is cell (col, row), rows
 * from the south. `NaN` where no DEM tile covers the cell.
 */
export interface HeightRaster {
	cols: number;
	rows: number;
	cellM: number;
	/** DEM zoom the heights come from (14 = per-step grades, 12 = 24 m baseline). */
	zoom: number;
	heights: Float32Array;
}

/** With only z12 available, grades are taken over this baseline (plan §6.4). */
export const COARSE_BASELINE_M = 24;
/** DEM zooms below this are "coarse": grades over {@link COARSE_BASELINE_M}. */
export const FINE_ROUTING_DEM_ZOOM = 14;

/** Number of cells the coarse (z12) grade baseline spans: `ceil(24 / cellM)`. */
export function baselineCells(cellM: number): number {
	return Math.ceil(COARSE_BASELINE_M / cellM);
}

/** Centre longitudes/latitudes of the haloed raster's columns and rows. */
function haloCentres(frame: RasterFrame): { lngs: number[]; lats: number[] } {
	const lngs: number[] = [];
	const lats: number[] = [];
	for (let c = -1; c <= frame.cols; c++) {
		lngs.push(frame.west + ((c + 0.5) * frame.cellM) / frame.mPerDegLng);
	}
	for (let r = -1; r <= frame.rows; r++) {
		lats.push(frame.south + ((r + 0.5) * frame.cellM) / M_PER_DEG_LAT);
	}
	return { lngs, lats };
}

/**
 * Keys of every DEM tile at zoom `z` the height raster of `frame` reads,
 * including the halo and the neighbour tiles bilinear sampling needs at tile
 * edges.
 */
export function tilesForFrame(frame: RasterFrame, z: number, size = 512): Set<string> {
	const { lngs, lats } = haloCentres(frame);
	const corners: GeoPoint[] = [];
	for (const lng of [lngs[0], lngs[lngs.length - 1]]) {
		for (const lat of [lats[0], lats[lats.length - 1]]) corners.push({ lng, lat });
	}
	const keys = tilesForSamples(corners, z, size);
	let xMin = Infinity;
	let xMax = -Infinity;
	let yMin = Infinity;
	let yMax = -Infinity;
	for (const key of keys) {
		const [x, y] = key.split('/').map(Number);
		xMin = Math.min(xMin, x);
		xMax = Math.max(xMax, x);
		yMin = Math.min(yMin, y);
		yMax = Math.max(yMax, y);
	}
	const all = new Set<string>();
	for (let x = xMin; x <= xMax; x++) for (let y = yMin; y <= yMax; y++) all.add(tileKey(x, y));
	return all;
}

/**
 * 3×3 mean over a `width` × `height` raster. `NaN` cells stay `NaN` and are
 * left out of their neighbours' means; at the border only the cells inside
 * count. A plane stays a plane (away from the border).
 */
export function smooth3x3(values: Float32Array, width: number, height: number): Float32Array {
	const out = new Float32Array(values.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			if (Number.isNaN(values[i])) {
				out[i] = NaN;
				continue;
			}
			let sum = 0;
			let n = 0;
			for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
				for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
					const v = values[yy * width + xx];
					if (!Number.isNaN(v)) {
						sum += v;
						n++;
					}
				}
			}
			out[i] = sum / n;
		}
	}
	return out;
}

/**
 * The height raster of a cost grid (plan §6.4): bilinear samples at every cell
 * centre plus a one-cell halo, read **across** tile edges from `tiles` (zoom
 * `z`, keyed by {@link tileKey}), then smoothed 3×3. Pure; the tiles come from
 * the caller.
 */
export function buildHeightRaster(
	frame: RasterFrame,
	tiles: Map<string, DecodedDemTile>,
	z: number
): HeightRaster {
	const { lngs, lats } = haloCentres(frame);
	const width = frame.cols + 2;
	const height = frame.rows + 2;
	const n = 2 ** z;
	// x depends on the longitude only, y on the latitude only.
	const txs = lngs.map((lng) => ((lng + 180) / 360) * n);
	const tys = lats.map((lat) => pointToTileCoord({ lat, lng: 0 }, z).ty);
	const sample = tileSampler(tiles);
	const raw = new Float32Array(width * height);
	for (let r = 0; r < height; r++) {
		for (let c = 0; c < width; c++) raw[r * width + c] = sample(txs[c], tys[r]) ?? NaN;
	}
	return {
		cols: frame.cols,
		rows: frame.rows,
		cellM: frame.cellM,
		zoom: z,
		heights: smooth3x3(raw, width, height)
	};
}

/** Height at cell (col, row) of the raster; the halo is col/row −1 and cols/rows. */
export function heightAt(raster: HeightRaster, col: number, row: number): number {
	const c = Math.min(Math.max(col, -1), raster.cols);
	const r = Math.min(Math.max(row, -1), raster.rows);
	return raster.heights[(r + 1) * (raster.cols + 2) + (c + 1)];
}

/**
 * Height at a fractional grid position (`gx`, `gy` in cells, cell centres at
 * +0.5), bilinear over the cell centres; `NaN` where a corner is unknown.
 */
export function heightAtGrid(raster: HeightRaster, gx: number, gy: number): number {
	const fx = gx - 0.5;
	const fy = gy - 0.5;
	const c = Math.floor(fx);
	const r = Math.floor(fy);
	const dx = fx - c;
	const dy = fy - r;
	const top = heightAt(raster, c, r) * (1 - dx) + heightAt(raster, c + 1, r) * dx;
	const bottom = heightAt(raster, c, r + 1) * (1 - dx) + heightAt(raster, c + 1, r + 1) * dx;
	return top * (1 - dy) + bottom * dy;
}

/** Height a fraction `t` of the way along a grid line, between whole cells. */
function heightAlong(
	raster: HeightRaster,
	x: number,
	y: number,
	dx: number,
	dy: number,
	t: number
) {
	const t0 = Math.floor(t);
	const f = t - t0;
	const a = heightAt(raster, x + dx * t0, y + dy * t0);
	if (f === 0) return a;
	return a * (1 - f) + heightAt(raster, x + dx * (t0 + 1), y + dy * (t0 + 1)) * f;
}

/**
 * |grade| of the grid step from cell (x, y) to (x + dx, y + dy) (`dx`, `dy` in
 * −1..1). Fine DEM (z14): the height difference of the two cells over the
 * step. Coarse DEM (z12): over a baseline of {@link baselineCells} steps
 * centred on the step, so a 12.75 m pixel does not fake a wall. Symmetric: the
 * reverse step has the same grade. `NaN` without heights.
 */
export function stepGrade(raster: HeightRaster, x: number, y: number, dx: number, dy: number) {
	const stepM = raster.cellM * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
	if (raster.zoom >= FINE_ROUTING_DEM_ZOOM) {
		return Math.abs(heightAt(raster, x + dx, y + dy) - heightAt(raster, x, y)) / stepM;
	}
	const k = baselineCells(raster.cellM);
	// Steps along the line from cell (x, y): the baseline is centred on the step's
	// midpoint (t = 0.5) and spans k steps.
	const a = heightAlong(raster, x, y, dx, dy, 0.5 - k / 2);
	const b = heightAlong(raster, x, y, dx, dy, 0.5 + k / 2);
	return Math.abs(b - a) / (k * stepM);
}
