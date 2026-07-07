import { GeoPoint, distanceTo } from '@/types/geo';
import { RoadLine } from '@/types/obstacles';

/**
 * Shortest-path routing over the road centerlines decoded from the basemap
 * vector tiles (see `src/mapHandler/obstacleGeometry.ts`). Fire hoses are laid
 * along roads, so this yields a far more useful distance to a hydrant than the
 * straight line.
 *
 * Data caveats this is designed around:
 * - Lines are clipped at tile boundaries; the continuation in the neighbouring
 *   tile starts at approximately (not exactly) the same coordinate due to
 *   per-tile quantization. Node merging is therefore tolerance-based.
 * - Crossing lines without a shared vertex (bridges/tunnels) are NOT connected;
 *   only shared/nearby vertices join.
 * - The network is fragmented: besides one dominant street component there are
 *   hundreds of tiny disconnected fragments (courtyard paths, driveways,
 *   clipped stubs). Snapping to the single nearest edge therefore often lands
 *   on an unreachable island. Points snap to the nearest edge of EACH nearby
 *   component instead, and the cheapest reachable total wins.
 * - The straight "leg" between a point and its snap position can cross
 *   buildings; callers can supply a `legCost` function (e.g. the
 *   building-weighted heuristic) so such legs are priced realistically.
 */

/** Max distance from a point to the road network for routing to apply. */
export const MAX_SNAP_M = 100;
/** Max distinct components considered per snapped point. */
const MAX_SNAP_COMPONENTS = 8;
/** Vertex-merge tolerance; also joins tile-boundary duplicates (~0.3 m quantization at z15). */
const NODE_MERGE_TOLERANCE_M = 2;
/** Cell size of the edge spatial index used for snapping. */
const SNAP_GRID_CELL_M = 75;

/** Meters per degree of latitude (equirectangular local frame). */
const M_PER_DEG_LAT = 110540;
/** Meters per degree of longitude at the equator; scaled by cos(latitude). */
const M_PER_DEG_LNG_EQUATOR = 111320;

/** Straight-line leg cost used when the caller doesn't supply one. */
export type LegCostFn = (from: GeoPoint, to: GeoPoint) => number;

interface GraphEdge {
	/** Node indexes of the endpoints. */
	a: number;
	b: number;
	/** Edge length in meters. */
	length: number;
}

export interface RoadGraph {
	/** Node positions as [lng, lat]. */
	nodes: [number, number][];
	/** Per-node list of (neighbour node, edge index) pairs. */
	adjacency: { node: number; edge: number }[][];
	edges: GraphEdge[];
	/** Connected-component id per node (fragmented networks are the norm). */
	nodeComponent: Int32Array;
	/** Spatial index: snap-grid cell key → edge indexes touching the cell. */
	edgeIndex: Map<string, number[]>;
	/** Meters per degree of longitude at the graph's mean latitude. */
	mPerDegLng: number;
}

/** Where a query point attaches to one component of the graph. */
interface SnapCandidate {
	edge: number;
	/** Position along the edge from endpoint `a`, 0..1. */
	t: number;
	/** The projected point on the edge. */
	position: GeoPoint;
	/** Straight distance from the query point to `position` in meters. */
	distance: number;
	/** Component the edge belongs to. */
	component: number;
	/** Leg cost from the query point to `position` (set by the router). */
	legCost: number;
}

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

function cellKey(cx: number, cy: number): string {
	return `${cx}_${cy}`;
}

/**
 * Builds an undirected road graph from decoded road centerlines. Consecutive
 * polyline vertices become edges; vertices closer than
 * {@link NODE_MERGE_TOLERANCE_M} are merged into one node (this joins both
 * in-tile intersections and tile-boundary continuations). Connected components
 * are labelled so snapping can offer one candidate per nearby component.
 */
export function buildRoadGraph(roads: RoadLine[]): RoadGraph {
	// Local meter frame anchored at the mean latitude of the input.
	let latSum = 0;
	let latCount = 0;
	for (const road of roads) {
		for (const p of road.points) {
			latSum += p[1];
			latCount++;
		}
	}
	const meanLat = latCount > 0 ? latSum / latCount : 0;
	const mPerDegLng = Math.cos(toRadians(meanLat)) * M_PER_DEG_LNG_EQUATOR;

	const nodes: [number, number][] = [];
	const adjacency: { node: number; edge: number }[][] = [];
	const edges: GraphEdge[] = [];
	// Merge grid: cell key → node indexes registered in that cell.
	const nodeGrid = new Map<string, number[]>();

	const mergeCell = (lng: number, lat: number): [number, number] => [
		Math.round((lng * mPerDegLng) / NODE_MERGE_TOLERANCE_M),
		Math.round((lat * M_PER_DEG_LAT) / NODE_MERGE_TOLERANCE_M)
	];

	/** Finds an existing node within the merge tolerance or registers a new one. */
	const nodeFor = (p: [number, number]): number => {
		const [cx, cy] = mergeCell(p[0], p[1]);
		// A near-duplicate may have been quantized into any neighbouring cell.
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const candidates = nodeGrid.get(cellKey(cx + dx, cy + dy));
				if (!candidates) continue;
				for (const idx of candidates) {
					const n = nodes[idx];
					const mx = (p[0] - n[0]) * mPerDegLng;
					const my = (p[1] - n[1]) * M_PER_DEG_LAT;
					if (mx * mx + my * my <= NODE_MERGE_TOLERANCE_M * NODE_MERGE_TOLERANCE_M) {
						return idx;
					}
				}
			}
		}
		const idx = nodes.length;
		nodes.push([p[0], p[1]]);
		adjacency.push([]);
		const key = cellKey(cx, cy);
		const cell = nodeGrid.get(key);
		if (cell) {
			cell.push(idx);
		} else {
			nodeGrid.set(key, [idx]);
		}
		return idx;
	};

	const edgeIndex = new Map<string, number[]>();
	const snapCell = (lng: number, lat: number): [number, number] => [
		Math.floor((lng * mPerDegLng) / SNAP_GRID_CELL_M),
		Math.floor((lat * M_PER_DEG_LAT) / SNAP_GRID_CELL_M)
	];

	const indexEdge = (edgeIdx: number, pa: [number, number], pb: [number, number]): void => {
		const [ax, ay] = snapCell(pa[0], pa[1]);
		const [bx, by] = snapCell(pb[0], pb[1]);
		for (let cx = Math.min(ax, bx); cx <= Math.max(ax, bx); cx++) {
			for (let cy = Math.min(ay, by); cy <= Math.max(ay, by); cy++) {
				const key = cellKey(cx, cy);
				const cell = edgeIndex.get(key);
				if (cell) {
					cell.push(edgeIdx);
				} else {
					edgeIndex.set(key, [edgeIdx]);
				}
			}
		}
	};

	for (const road of roads) {
		for (let i = 0; i < road.points.length - 1; i++) {
			const pa = road.points[i];
			const pb = road.points[i + 1];
			const a = nodeFor(pa);
			const b = nodeFor(pb);
			if (a === b) continue;
			const length = distanceTo(
				{ lat: nodes[a][1], lng: nodes[a][0] },
				{ lat: nodes[b][1], lng: nodes[b][0] }
			);
			if (length <= 0) continue;
			const edgeIdx = edges.length;
			edges.push({ a, b, length });
			adjacency[a].push({ node: b, edge: edgeIdx });
			adjacency[b].push({ node: a, edge: edgeIdx });
			indexEdge(edgeIdx, nodes[a], nodes[b]);
		}
	}

	// Label connected components (union-find with path halving).
	const parent = new Int32Array(nodes.length);
	for (let i = 0; i < parent.length; i++) parent[i] = i;
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	for (const edge of edges) {
		const ra = find(edge.a);
		const rb = find(edge.b);
		if (ra !== rb) parent[ra] = rb;
	}
	const nodeComponent = new Int32Array(nodes.length);
	for (let i = 0; i < nodes.length; i++) nodeComponent[i] = find(i);

	return { nodes, adjacency, edges, nodeComponent, edgeIndex, mPerDegLng };
}

/**
 * Projects `point` onto the nearest edge of EACH connected component within
 * {@link MAX_SNAP_M} (up to {@link MAX_SNAP_COMPONENTS}, nearest components
 * first). Multiple candidates are essential: the nearest edge is frequently an
 * unreachable island fragment while the real street network passes a few
 * meters farther away. Returns an empty array when no road is in range.
 */
function snapCandidates(graph: RoadGraph, point: GeoPoint): SnapCandidate[] {
	if (graph.edges.length === 0) return [];

	const px = point.lng * graph.mPerDegLng;
	const py = point.lat * M_PER_DEG_LAT;
	const cellRadius = Math.ceil(MAX_SNAP_M / SNAP_GRID_CELL_M);
	const ccx = Math.floor(px / SNAP_GRID_CELL_M);
	const ccy = Math.floor(py / SNAP_GRID_CELL_M);

	const bestPerComponent = new Map<number, SnapCandidate>();
	const seen = new Set<number>();

	for (let cx = ccx - cellRadius; cx <= ccx + cellRadius; cx++) {
		for (let cy = ccy - cellRadius; cy <= ccy + cellRadius; cy++) {
			const cell = graph.edgeIndex.get(cellKey(cx, cy));
			if (!cell) continue;
			for (const edgeIdx of cell) {
				if (seen.has(edgeIdx)) continue;
				seen.add(edgeIdx);
				const edge = graph.edges[edgeIdx];
				const na = graph.nodes[edge.a];
				const nb = graph.nodes[edge.b];
				const ax = na[0] * graph.mPerDegLng;
				const ay = na[1] * M_PER_DEG_LAT;
				const bx = nb[0] * graph.mPerDegLng;
				const by = nb[1] * M_PER_DEG_LAT;
				const dx = bx - ax;
				const dy = by - ay;
				const lengthSq = dx * dx + dy * dy;
				const t =
					lengthSq === 0
						? 0
						: Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
				const qx = ax + t * dx;
				const qy = ay + t * dy;
				const dist = Math.hypot(px - qx, py - qy);
				if (dist > MAX_SNAP_M) continue;
				const component = graph.nodeComponent[edge.a];
				const current = bestPerComponent.get(component);
				if (!current || dist < current.distance) {
					bestPerComponent.set(component, {
						edge: edgeIdx,
						t,
						position: { lng: qx / graph.mPerDegLng, lat: qy / M_PER_DEG_LAT },
						distance: dist,
						component,
						legCost: dist
					});
				}
			}
		}
	}

	return [...bestPerComponent.values()]
		.sort((a, b) => a.distance - b.distance)
		.slice(0, MAX_SNAP_COMPONENTS);
}

/** Minimal binary min-heap over (distance, node) pairs with lazy deletion. */
class MinHeap {
	private dist: number[] = [];
	private node: number[] = [];

	get size(): number {
		return this.dist.length;
	}

	push(distance: number, nodeIdx: number): void {
		this.dist.push(distance);
		this.node.push(nodeIdx);
		let i = this.dist.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (this.dist[parent] <= this.dist[i]) break;
			this.swap(i, parent);
			i = parent;
		}
	}

	pop(): { distance: number; nodeIdx: number } | null {
		if (this.dist.length === 0) return null;
		const top = { distance: this.dist[0], nodeIdx: this.node[0] };
		const lastDist = this.dist.pop() as number;
		const lastNode = this.node.pop() as number;
		if (this.dist.length > 0) {
			this.dist[0] = lastDist;
			this.node[0] = lastNode;
			let i = 0;
			for (;;) {
				const left = 2 * i + 1;
				const right = left + 1;
				let smallest = i;
				if (left < this.dist.length && this.dist[left] < this.dist[smallest]) smallest = left;
				if (right < this.dist.length && this.dist[right] < this.dist[smallest]) smallest = right;
				if (smallest === i) break;
				this.swap(i, smallest);
				i = smallest;
			}
		}
		return top;
	}

	private swap(i: number, j: number): void {
		[this.dist[i], this.dist[j]] = [this.dist[j], this.dist[i]];
		[this.node[i], this.node[j]] = [this.node[j], this.node[i]];
	}
}

interface OriginSolve {
	candidates: SnapCandidate[];
	/** Cheapest cost from the origin POINT (leg included) to each node; Infinity = unreachable. */
	dist: Float64Array;
	/** Predecessor node for path reconstruction (-1 = seeded directly from a snap). */
	prev: Int32Array;
	/** Index into `candidates` of the snap that ultimately fed each node. */
	seed: Int32Array;
}

/**
 * Multi-seeded Dijkstra from the origin point: every snap candidate seeds the
 * endpoints of its edge with `legCost + along-edge offset`, so `dist[]`
 * already includes the approach leg and the cheapest reachable component wins
 * naturally.
 */
function solveFromOrigin(
	graph: RoadGraph,
	origin: GeoPoint,
	legCost: LegCostFn
): OriginSolve | null {
	const candidates = snapCandidates(graph, origin);
	if (candidates.length === 0) return null;

	const n = graph.nodes.length;
	const dist = new Float64Array(n).fill(Infinity);
	const prev = new Int32Array(n).fill(-1);
	const seed = new Int32Array(n).fill(-1);
	const done = new Uint8Array(n);
	const heap = new MinHeap();

	candidates.forEach((candidate, ci) => {
		candidate.legCost = legCost(origin, candidate.position);
		const edge = graph.edges[candidate.edge];
		const costA = candidate.legCost + candidate.t * edge.length;
		const costB = candidate.legCost + (1 - candidate.t) * edge.length;
		if (costA < dist[edge.a]) {
			dist[edge.a] = costA;
			seed[edge.a] = ci;
			heap.push(costA, edge.a);
		}
		if (costB < dist[edge.b]) {
			dist[edge.b] = costB;
			seed[edge.b] = ci;
			heap.push(costB, edge.b);
		}
	});

	for (;;) {
		const top = heap.pop();
		if (!top) break;
		const u = top.nodeIdx;
		if (done[u]) continue;
		done[u] = 1;
		for (const { node: v, edge: e } of graph.adjacency[u]) {
			if (done[v]) continue;
			const candidate = dist[u] + graph.edges[e].length;
			if (candidate < dist[v]) {
				dist[v] = candidate;
				prev[v] = u;
				seed[v] = seed[u];
				heap.push(candidate, v);
			}
		}
	}

	return { candidates, dist, prev, seed };
}

interface Arrival {
	/** Total cost origin point → target point (both legs included). */
	cost: number;
	/** Geometric length in meters of the same route (legs at face value). */
	meters: number;
	target: SnapCandidate;
	/** Node the route enters the target edge from, or -1 for the direct same-edge run. */
	entry: number;
	/** Origin candidate of the direct same-edge run (set only when entry === -1). */
	directFrom: SnapCandidate | null;
}

/** Routed result: `cost` ranks (legs priced by `legCost`), `meters` is the geometric length. */
export interface RouteResult {
	cost: number;
	meters: number;
}

/**
 * Cheapest arrival at `target` given a solved origin: evaluates every target
 * snap candidate via both edge endpoints, plus the direct along-edge run when
 * an origin candidate sits on the same edge.
 */
function bestArrival(
	graph: RoadGraph,
	solve: OriginSolve,
	target: GeoPoint,
	legCost: LegCostFn
): Arrival | null {
	let best: Arrival | null = null;

	for (const tc of snapCandidates(graph, target)) {
		tc.legCost = legCost(target, tc.position);
		const edge = graph.edges[tc.edge];
		const viaA = solve.dist[edge.a] + tc.t * edge.length;
		const viaB = solve.dist[edge.b] + (1 - tc.t) * edge.length;
		const via = Math.min(viaA, viaB);
		if (Number.isFinite(via)) {
			const cost = via + tc.legCost;
			if (!best || cost < best.cost) {
				const entry = viaA <= viaB ? edge.a : edge.b;
				// dist[] carries the origin leg at its priced cost; swap both legs
				// for their geometric distances to get the real path length.
				const oc = solve.candidates[solve.seed[entry]];
				const meters = via - oc.legCost + oc.distance + tc.distance;
				best = { cost, meters, target: tc, entry, directFrom: null };
			}
		}
		// Direct along-edge run when an origin candidate sits on the same edge
		// (no node detour — matters on short isolated fragments).
		for (const oc of solve.candidates) {
			if (oc.edge !== tc.edge) continue;
			const along = Math.abs(tc.t - oc.t) * edge.length;
			const cost = oc.legCost + along + tc.legCost;
			if (!best || cost < best.cost) {
				best = {
					cost,
					meters: oc.distance + along + tc.distance,
					target: tc,
					entry: -1,
					directFrom: oc
				};
			}
		}
	}

	return best;
}

/**
 * Routed results from `origin` to each target along the road network,
 * including both approach legs. `cost` (legs priced by `legCost`) is the
 * ranking key; `meters` is the geometric length for display. ONE Dijkstra
 * traversal serves all targets. `null` per target when it can't snap within
 * {@link MAX_SNAP_M} of a reachable component; all `null` when the origin
 * can't snap at all.
 */
export function routeFromOrigin(
	graph: RoadGraph,
	origin: GeoPoint,
	targets: GeoPoint[],
	legCost: LegCostFn = distanceTo
): (RouteResult | null)[] {
	const solve = solveFromOrigin(graph, origin, legCost);
	if (!solve) return targets.map(() => null);

	return targets.map((target) => {
		const arrival = bestArrival(graph, solve, target, legCost);
		return arrival ? { cost: arrival.cost, meters: arrival.meters } : null;
	});
}

/**
 * Full display polyline for the route `origin` → `target`: origin, origin snap
 * point, node chain along the shortest path, target snap point, target.
 * Returns `null` when either end can't snap to a mutually reachable component.
 */
export function routePath(
	graph: RoadGraph,
	origin: GeoPoint,
	target: GeoPoint,
	legCost: LegCostFn = distanceTo
): GeoPoint[] | null {
	const solve = solveFromOrigin(graph, origin, legCost);
	if (!solve) return null;
	const arrival = bestArrival(graph, solve, target, legCost);
	if (!arrival) return null;

	if (arrival.entry === -1 && arrival.directFrom) {
		// Same-edge run: straight along the shared edge segment.
		return [origin, arrival.directFrom.position, arrival.target.position, target];
	}

	// Node chain backwards from the entry endpoint to the seeded origin snap
	// (prev = -1 marks a seed node; seed[] names the snap that fed it).
	const chain: number[] = [];
	let node = arrival.entry;
	for (;;) {
		chain.push(node);
		const p = solve.prev[node];
		if (p === -1) break;
		node = p;
	}
	chain.reverse();
	const originCandidate = solve.candidates[solve.seed[chain[0]]];

	const path: GeoPoint[] = [origin, originCandidate.position];
	for (const nodeIdx of chain) {
		path.push({ lng: graph.nodes[nodeIdx][0], lat: graph.nodes[nodeIdx][1] });
	}
	path.push(arrival.target.position, target);
	return path;
}
