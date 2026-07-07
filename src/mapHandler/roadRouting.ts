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
 */

/** Max distance from a point to the road network for routing to apply. */
export const MAX_SNAP_M = 100;
/** Vertex-merge tolerance; also joins tile-boundary duplicates (~0.3 m quantization at z15). */
const NODE_MERGE_TOLERANCE_M = 2;
/** Cell size of the edge spatial index used for snapping. */
const SNAP_GRID_CELL_M = 75;

/** Meters per degree of latitude (equirectangular local frame). */
const M_PER_DEG_LAT = 110540;
/** Meters per degree of longitude at the equator; scaled by cos(latitude). */
const M_PER_DEG_LNG_EQUATOR = 111320;

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
	/** Spatial index: snap-grid cell key → edge indexes touching the cell. */
	edgeIndex: Map<string, number[]>;
	/** Meters per degree of longitude at the graph's mean latitude. */
	mPerDegLng: number;
}

/** Where a query point attaches to the graph. */
interface SnapResult {
	edge: number;
	/** Position along the edge from endpoint `a`, 0..1. */
	t: number;
	/** The projected point on the edge. */
	position: GeoPoint;
	/** Straight distance from the query point to `position` in meters. */
	distance: number;
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
 * in-tile intersections and tile-boundary continuations).
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

	return { nodes, adjacency, edges, edgeIndex, mPerDegLng };
}

/**
 * Projects `point` onto the nearest edge within {@link MAX_SNAP_M}, using the
 * spatial index so the search only touches nearby cells. Returns `null` when
 * the road network is too far away.
 */
function snapToGraph(graph: RoadGraph, point: GeoPoint): SnapResult | null {
	if (graph.edges.length === 0) return null;

	const px = point.lng * graph.mPerDegLng;
	const py = point.lat * M_PER_DEG_LAT;
	const cellRadius = Math.ceil(MAX_SNAP_M / SNAP_GRID_CELL_M);
	const ccx = Math.floor(px / SNAP_GRID_CELL_M);
	const ccy = Math.floor(py / SNAP_GRID_CELL_M);

	let best: SnapResult | null = null;
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
				if (dist <= MAX_SNAP_M && (!best || dist < best.distance)) {
					best = {
						edge: edgeIdx,
						t,
						position: { lng: qx / graph.mPerDegLng, lat: qy / M_PER_DEG_LAT },
						distance: dist
					};
				}
			}
		}
	}

	return best;
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

interface DijkstraResult {
	/** Shortest graph distance from the snapped origin to each node (Infinity = unreachable). */
	dist: Float64Array;
	/** Predecessor node index for path reconstruction (-1 = seed/unreached). */
	prev: Int32Array;
}

/**
 * Single-source Dijkstra from a snapped origin: both endpoints of the snapped
 * edge are seeded with their along-edge offsets, so distances are measured from
 * the snap point itself.
 */
function dijkstraFromSnap(graph: RoadGraph, origin: SnapResult): DijkstraResult {
	const n = graph.nodes.length;
	const dist = new Float64Array(n).fill(Infinity);
	const prev = new Int32Array(n).fill(-1);
	const done = new Uint8Array(n);
	const heap = new MinHeap();

	const edge = graph.edges[origin.edge];
	dist[edge.a] = origin.t * edge.length;
	dist[edge.b] = (1 - origin.t) * edge.length;
	heap.push(dist[edge.a], edge.a);
	heap.push(dist[edge.b], edge.b);

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
				heap.push(candidate, v);
			}
		}
	}

	return { dist, prev };
}

/**
 * Graph distance from a solved origin to a snapped target, handling the
 * degenerate case where both snap points lie on the same edge (direct
 * along-edge run, no node detour).
 */
function graphDistanceToSnap(
	graph: RoadGraph,
	origin: SnapResult,
	solved: DijkstraResult,
	target: SnapResult
): number {
	const edge = graph.edges[target.edge];
	let best = Math.min(
		solved.dist[edge.a] + target.t * edge.length,
		solved.dist[edge.b] + (1 - target.t) * edge.length
	);
	if (target.edge === origin.edge) {
		best = Math.min(best, Math.abs(target.t - origin.t) * edge.length);
	}
	return best;
}

/**
 * Routed distances (meters) from `origin` to each target along the road
 * network: straight leg to the snapped origin + shortest graph path + straight
 * leg from the target's snap point. ONE Dijkstra traversal serves all targets.
 * `null` per target when it can't snap within {@link MAX_SNAP_M} or its
 * component is unreachable; all `null` when the origin can't snap.
 */
export function routeFromOrigin(
	graph: RoadGraph,
	origin: GeoPoint,
	targets: GeoPoint[]
): (number | null)[] {
	const snappedOrigin = snapToGraph(graph, origin);
	if (!snappedOrigin) return targets.map(() => null);

	const solved = dijkstraFromSnap(graph, snappedOrigin);
	const originLeg = distanceTo(origin, snappedOrigin.position);

	return targets.map((target) => {
		const snappedTarget = snapToGraph(graph, target);
		if (!snappedTarget) return null;
		const graphDist = graphDistanceToSnap(graph, snappedOrigin, solved, snappedTarget);
		if (!Number.isFinite(graphDist)) return null;
		return originLeg + graphDist + distanceTo(snappedTarget.position, target);
	});
}

/**
 * Full display polyline for the route `origin` → `target`: origin, origin snap
 * point, node chain along the shortest path, target snap point, target.
 * Returns `null` when either end can't snap or no path exists.
 */
export function routePath(graph: RoadGraph, origin: GeoPoint, target: GeoPoint): GeoPoint[] | null {
	const snappedOrigin = snapToGraph(graph, origin);
	const snappedTarget = snapToGraph(graph, target);
	if (!snappedOrigin || !snappedTarget) return null;

	const originEdge = graph.edges[snappedOrigin.edge];
	const targetEdge = graph.edges[snappedTarget.edge];
	const solved = dijkstraFromSnap(graph, snappedOrigin);

	const viaA = solved.dist[targetEdge.a] + snappedTarget.t * targetEdge.length;
	const viaB = solved.dist[targetEdge.b] + (1 - snappedTarget.t) * targetEdge.length;
	const bestViaNodes = Math.min(viaA, viaB);
	const sameEdge = snappedTarget.edge === snappedOrigin.edge;
	const alongEdge = sameEdge
		? Math.abs(snappedTarget.t - snappedOrigin.t) * originEdge.length
		: Infinity;

	if (!Number.isFinite(Math.min(bestViaNodes, alongEdge))) return null;

	const path: GeoPoint[] = [origin, snappedOrigin.position];

	if (alongEdge <= bestViaNodes) {
		// Both snap points on the same edge: run straight along it.
		path.push(snappedTarget.position, target);
		return path;
	}

	// Reconstruct the node chain backwards from the target's entry endpoint to
	// the seeded origin endpoint (prev = -1 marks a seed).
	const entry = viaA <= viaB ? targetEdge.a : targetEdge.b;
	const chain: number[] = [];
	for (let node = entry; node !== -1; node = solved.prev[node]) {
		chain.push(node);
	}
	chain.reverse();
	for (const node of chain) {
		path.push({ lng: graph.nodes[node][0], lat: graph.nodes[node][1] });
	}

	path.push(snappedTarget.position, target);
	return path;
}
