import type { GeoBounds } from '@/types/geo';
import type { ObstacleData, RoadLine } from '@/types/obstacles';
import {
	CELL_CLASS,
	CLIFF_CLASS,
	type CellClass,
	classifyLanduse,
	classifyRail,
	classifyRoad,
	classifyWaterArea,
	classifyWaterLine
} from '@/mapHandler/hoseCostModel';

/**
 * Rasterises the decoded obstacles into the cost classes of `hoseCostModel.ts`
 * for the `optimized` hose routing mode (plan §6.3, §6.10): scanline polygon
 * fill (even-odd, holes respected) and supercover line traversal, drawn in the
 * plan's order so later layers overwrite earlier ones:
 *
 * 1. `UNKNOWN_OPEN` everywhere;
 * 2. landuse, largest polygon first (a park inside residential wins);
 * 3. water polygons `BLOCKED`, water lines `STREAM` or `BLOCKED`;
 * 4. buildings: `BUILDING_CORE` where the cell centre is inside, `BUILDING_FRINGE`
 *    where only an edge touches the cell;
 * 5. surface heavy rail, surface motorway and cliffs `BLOCKED`;
 * 6. passable roads and paths that are not bridges;
 * 7. bridges `BRIDGE`.
 *
 * On grids finer than 8 m (single paths, plan §6.10) ways are drawn 8 m wide
 * over open ground and landuse ({@link ROAD_BAND_HALF_WIDTH_M}).
 *
 * Roads go last, so level crossings, underpasses and bridges stay passable.
 * Features `classifyRoad` excludes (ferries, corridors, tunnelled paths,
 * military access) and those it draws nowhere (tram, subway, bridged or
 * tunnelled rail and motorway) are skipped.
 *
 * Pure module: no store, map or network imports; safe in a worker.
 */

export const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQUATOR = 111320;

/** Placement of a grid: cell (col, row) spans `west + col * cellM` ... in local metres. */
export interface GridFrame {
	west: number;
	south: number;
	/** Metres per degree of longitude at the window's mid latitude. */
	mPerDegLng: number;
	cols: number;
	rows: number;
	/** Cell edge in metres. */
	cellM: number;
}

/** A rasterised cost grid: one {@link CellClass} per cell, row-major from the south-west. */
export interface CostRaster extends GridFrame {
	cells: Uint8Array;
}

/** The frame covering `bounds`, or `null` when it is empty or above `maxCells`. */
export function gridFrameFor(bounds: GeoBounds, cellM: number, maxCells: number): GridFrame | null {
	const midLat = (bounds.south + bounds.north) / 2;
	const mPerDegLng = Math.cos((midLat * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR;
	const cols = Math.ceil(((bounds.east - bounds.west) * mPerDegLng) / cellM);
	const rows = Math.ceil(((bounds.north - bounds.south) * M_PER_DEG_LAT) / cellM);
	if (cols <= 0 || rows <= 0 || cols * rows > maxCells) return null;
	return { west: bounds.west, south: bounds.south, mPerDegLng, cols, rows, cellM };
}

/** Fractional grid x (columns) of a longitude; cell `c` spans [c, c + 1). */
export function gridX(frame: GridFrame, lng: number): number {
	return ((lng - frame.west) * frame.mPerDegLng) / frame.cellM;
}

/** Fractional grid y (rows) of a latitude. */
export function gridY(frame: GridFrame, lat: number): number {
	return ((lat - frame.south) * M_PER_DEG_LAT) / frame.cellM;
}

/**
 * Calls `visit` for every cell whose CENTRE lies inside the polygon (even-odd
 * over all rings, so holes are respected). The crossing rule is the one of
 * `pointInRings` (`polygonGeometry.ts`), so the filled set equals a centre
 * point-in-polygon test, one scanline per row instead of one test per cell.
 */
export function scanlineFill(
	frame: GridFrame,
	rings: [number, number][][],
	visit: (cell: number) => void
): void {
	const ringsXY = rings.map((ring) =>
		ring.map(([lng, lat]) => [gridX(frame, lng), gridY(frame, lat)] as [number, number])
	);
	let yMin = Infinity;
	let yMax = -Infinity;
	for (const ring of ringsXY) {
		for (const [, y] of ring) {
			if (y < yMin) yMin = y;
			if (y > yMax) yMax = y;
		}
	}
	const r0 = Math.max(0, Math.ceil(yMin - 0.5));
	const r1 = Math.min(frame.rows - 1, Math.floor(yMax - 0.5));
	const xs: number[] = [];
	for (let r = r0; r <= r1; r++) {
		const yc = r + 0.5;
		xs.length = 0;
		for (const ring of ringsXY) {
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [xi, yi] = ring[i];
				const [xj, yj] = ring[j];
				if (yi > yc !== yj > yc) xs.push(((xj - xi) * (yc - yi)) / (yj - yi) + xi);
			}
		}
		if (xs.length < 2) continue;
		xs.sort((a, b) => a - b);
		// A centre xc is inside when an odd number of crossings lie at or left of it:
		// x[2k] <= xc < x[2k + 1].
		for (let k = 0; k + 1 < xs.length; k += 2) {
			const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
			const c1 = Math.min(frame.cols - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
			const base = r * frame.cols;
			for (let c = c0; c <= c1; c++) visit(base + c);
		}
	}
}

/**
 * Supercover traversal of the segment (ax, ay) → (bx, by) in fractional grid
 * coordinates: every cell the segment passes through, in order, with the
 * parameter interval [t0, t1] (0..1 along the segment) spent in it. Where the
 * segment passes exactly through a cell corner both side cells are visited
 * with an empty interval, so a drawn line is always a 4-connected wall. Cells
 * outside the frame are reported with `cell = -1`.
 *
 * Return `false` from `visit` to stop early.
 */
export function traverseSegment(
	frame: GridFrame,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	visit: (cell: number, t0: number, t1: number) => boolean | void
): void {
	const cellIndex = (x: number, y: number) =>
		x >= 0 && x < frame.cols && y >= 0 && y < frame.rows ? y * frame.cols + x : -1;
	let x = Math.floor(ax);
	let y = Math.floor(ay);
	const endX = Math.floor(bx);
	const endY = Math.floor(by);
	const dx = bx - ax;
	const dy = by - ay;
	const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
	const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
	const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
	const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
	let tMaxX = stepX > 0 ? (x + 1 - ax) / dx : stepX < 0 ? (ax - x) / -dx : Infinity;
	let tMaxY = stepY > 0 ? (y + 1 - ay) / dy : stepY < 0 ? (ay - y) / -dy : Infinity;
	let t = 0;
	// Each iteration moves one cell closer in x or y (or both at a corner).
	let guard = Math.abs(endX - x) + Math.abs(endY - y) + 2;
	for (;;) {
		const atEnd = x === endX && y === endY;
		const tNext = atEnd ? 1 : Math.min(tMaxX, tMaxY, 1);
		if (visit(cellIndex(x, y), t, tNext) === false) return;
		if (atEnd || tNext >= 1 || --guard < 0) return;
		if (tMaxX < tMaxY) {
			x += stepX;
			t = tMaxX;
			tMaxX += tDeltaX;
		} else if (tMaxY < tMaxX) {
			y += stepY;
			t = tMaxY;
			tMaxY += tDeltaY;
		} else {
			// Exactly through a corner: touch both side cells, then go diagonal.
			t = tMaxX;
			if (visit(cellIndex(x + stepX, y), t, t) === false) return;
			if (visit(cellIndex(x, y + stepY), t, t) === false) return;
			x += stepX;
			y += stepY;
			tMaxX += tDeltaX;
			tMaxY += tDeltaY;
		}
	}
}

/** Calls `visit` for every cell a [lng, lat] polyline passes through (supercover). */
export function supercoverLine(
	frame: GridFrame,
	points: [number, number][],
	visit: (cell: number) => void
): void {
	for (let i = 0; i + 1 < points.length; i++) {
		traverseSegment(
			frame,
			gridX(frame, points[i][0]),
			gridY(frame, points[i][1]),
			gridX(frame, points[i + 1][0]),
			gridY(frame, points[i + 1][1]),
			(cell) => {
				if (cell >= 0) visit(cell);
			}
		);
	}
	if (points.length === 1) {
		traverseSegment(
			frame,
			gridX(frame, points[0][0]),
			gridY(frame, points[0][1]),
			gridX(frame, points[0][0]),
			gridY(frame, points[0][1]),
			(cell) => {
				if (cell >= 0) visit(cell);
			}
		);
	}
}

/** Supercover of every ring edge of a polygon (rings are closed in the data). */
function supercoverRings(
	frame: GridFrame,
	rings: [number, number][][],
	visit: (cell: number) => void
): void {
	for (const ring of rings) {
		const closed =
			ring.length > 2 &&
			(ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
				? [...ring, ring[0]]
				: ring;
		supercoverLine(frame, closed, visit);
	}
}

/** True when a feature's bbox overlaps the frame (cheap skip of far features). */
function overlapsFrame(frame: GridFrame, bbox: [number, number, number, number]): boolean {
	const x0 = gridX(frame, bbox[0]);
	const x1 = gridX(frame, bbox[2]);
	const y0 = gridY(frame, bbox[1]);
	const y1 = gridY(frame, bbox[3]);
	return x1 >= 0 && x0 <= frame.cols && y1 >= 0 && y0 <= frame.rows;
}

/**
 * Builds the `optimized` class raster for `frame` from decoded obstacles, in
 * the order described in the module comment.
 */
export function rasterizeCostClasses(obstacles: ObstacleData, frame: GridFrame): CostRaster {
	const cells = new Uint8Array(frame.cols * frame.rows); // 0 = UNKNOWN_OPEN
	const paint = (cls: CellClass) => (cell: number) => {
		cells[cell] = cls;
	};

	// 2. Landuse, largest first so nested smaller polygons overwrite.
	const landuse = obstacles.landuse
		.filter((area) => overlapsFrame(frame, area.bbox))
		.sort((a, b) => b.areaM2 - a.areaM2);
	for (const area of landuse) scanlineFill(frame, area.rings, paint(classifyLanduse(area.kind)));

	// 3. Water.
	for (const water of obstacles.waterAreas) {
		if (overlapsFrame(frame, water.bbox)) {
			scanlineFill(frame, water.rings, paint(classifyWaterArea(water.kind)));
		}
	}
	for (const line of obstacles.waterLines) {
		if (overlapsFrame(frame, line.bbox)) {
			supercoverLine(frame, line.points, paint(classifyWaterLine(line.kind, line.kindDetail)));
		}
	}

	// 4. Buildings: core by centre, fringe where an edge touches the cell. A fringe
	// never opens a blocked cell (a house on the shore must not make the lake
	// passable) and never downgrades another building's core.
	for (const building of obstacles.buildings) {
		if (!overlapsFrame(frame, building.bbox)) continue;
		scanlineFill(frame, building.rings, paint(CELL_CLASS.BUILDING_CORE));
		supercoverRings(frame, building.rings, (cell) => {
			const current = cells[cell];
			if (current !== CELL_CLASS.BUILDING_CORE && current !== CELL_CLASS.BLOCKED) {
				cells[cell] = CELL_CLASS.BUILDING_FRINGE;
			}
		});
	}

	// 5. Walls: surface heavy rail, surface motorway, cliffs.
	const blocked = paint(CELL_CLASS.BLOCKED);
	for (const rail of obstacles.rails) {
		if (classifyRail(rail) === CELL_CLASS.BLOCKED && overlapsFrame(frame, rail.bbox)) {
			supercoverLine(frame, rail.points, blocked);
		}
	}
	const passable: { road: RoadLine; cls: CellClass }[] = [];
	for (const road of obstacles.roads) {
		const effect = classifyRoad(road);
		if (effect === 'excluded' || effect === 'none') continue;
		if (!overlapsFrame(frame, road.bbox)) continue;
		if (effect === CELL_CLASS.BLOCKED) supercoverLine(frame, road.points, blocked);
		else passable.push({ road, cls: effect });
	}
	for (const cliff of obstacles.cliffs) {
		if (overlapsFrame(frame, cliff.bbox)) supercoverLine(frame, cliff.points, paint(CLIFF_CLASS));
	}

	// 6./7. Passable ways: paths and steps first, then roads (the cheaper class
	// wins a shared cell), then bridges on top.
	const order: CellClass[] = [
		CELL_CLASS.STEPS,
		CELL_CLASS.PATH,
		CELL_CLASS.ROAD,
		CELL_CLASS.BRIDGE
	];
	// Below 8 m cells a one-cell line is narrower than the road it stands for,
	// so ways also take the cells whose centre is within ROAD_BAND_HALF_WIDTH_M,
	// but only over open ground and landuse (never a building, water or wall).
	const widen = frame.cellM < 2 * ROAD_BAND_HALF_WIDTH_M;
	for (const cls of order) {
		for (const way of passable) {
			if (way.cls !== cls) continue;
			supercoverLine(frame, way.road.points, paint(cls));
			if (widen) {
				bandCells(frame, way.road.points, ROAD_BAND_HALF_WIDTH_M, (cell) => {
					if (WIDENABLE[cells[cell]]) cells[cell] = cls;
				});
			}
		}
	}

	return { ...frame, cells };
}

/**
 * Half width (m) of the band a road, path, steps or bridge line paints on
 * grids finer than 8 m (plan §6.10): 8 m wide, as one 8 m cell, which is what
 * phases 3-5 were tuned on. Without it a 4 m grid prices a hose a metre beside
 * the centreline as forest or field, and routes along roads come out zigzagged
 * and up to 7 % longer than on 8 m cells.
 */
export const ROAD_BAND_HALF_WIDTH_M = 4;

/** Classes a widened way may paint over: open ground and landuse, and narrower ways. */
const WIDENABLE: boolean[] = (() => {
	const table: boolean[] = [];
	for (const cls of [
		CELL_CLASS.UNKNOWN_OPEN,
		CELL_CLASS.OPEN,
		CELL_CLASS.FOREST,
		CELL_CLASS.YARD,
		CELL_CLASS.RAIL_LANDUSE,
		CELL_CLASS.STEPS,
		CELL_CLASS.PATH
	]) {
		table[cls] = true;
	}
	return table;
})();

/**
 * Calls `visit` for every cell whose centre lies within `halfWidthM` of the
 * polyline (cells next to its supercover; may repeat a cell).
 */
export function bandCells(
	frame: GridFrame,
	points: [number, number][],
	halfWidthM: number,
	visit: (cell: number) => void
): void {
	const reach = Math.ceil(halfWidthM / frame.cellM);
	const limit = (halfWidthM / frame.cellM) ** 2;
	for (let i = 0; i + 1 < points.length; i++) {
		const ax = gridX(frame, points[i][0]);
		const ay = gridY(frame, points[i][1]);
		const bx = gridX(frame, points[i + 1][0]);
		const by = gridY(frame, points[i + 1][1]);
		const dx = bx - ax;
		const dy = by - ay;
		const lenSq = dx * dx + dy * dy;
		traverseSegment(frame, ax, ay, bx, by, (_cell, t0, t1) => {
			// The cell at the middle of the piece (the one traverseSegment is in).
			const tm = (t0 + t1) / 2;
			const cx = Math.floor(ax + dx * tm);
			const cy = Math.floor(ay + dy * tm);
			for (let y = cy - reach; y <= cy + reach; y++) {
				if (y < 0 || y >= frame.rows) continue;
				for (let x = cx - reach; x <= cx + reach; x++) {
					if (x < 0 || x >= frame.cols) continue;
					const px = x + 0.5 - ax;
					const py = y + 0.5 - ay;
					const t = lenSq > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq)) : 0;
					const ex = px - t * dx;
					const ey = py - t * dy;
					if (ex * ex + ey * ey <= limit) visit(y * frame.cols + x);
				}
			}
		});
	}
}

/** Roads that take part in routing at all: everything `classifyRoad` does not exclude. */
export function routableRoads(roads: RoadLine[]): RoadLine[] {
	return roads.filter((road) => classifyRoad(road) !== 'excluded');
}
