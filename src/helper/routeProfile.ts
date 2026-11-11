import { GeoPoint, distanceTo } from '@/types/geo';
import type { RoadLine } from '@/types/obstacles';

/**
 * Steepness and off-road classification of a hose route (plan §6.8), shared by
 * every routing mode. The route is resampled every {@link PROFILE_STEP_M}; a
 * stretch is "steep" when some {@link GRADE_WINDOW_M} window over it rises or
 * falls more than 25 %, "very steep" above 50 %. Runs shorter than
 * {@link MIN_RUN_M} are dropped. With only the coarse z12 DEM the grade is
 * taken over {@link GRADE_WINDOW_Z12_M} and at most "steep" is shown.
 *
 * On a bridge the DEM shows the ground (or river) below the deck, not the
 * deck: the grade is taken over "deck heights" there, the heights linearly
 * interpolated across the bridge and {@link BRIDGE_APPROACH_M} on either side
 * (the embankment the DEM smooths into the valley), so the display agrees
 * with the routing cost, which ignores slope on bridge cells (plan §6.4).
 *
 * Pure module: heights, the off-road and the bridge test come from the caller;
 * {@link isNearAnyRoad} is the road proximity test the off-road display uses
 * where no cost-grid class is at hand, {@link isAlongBridge} the bridge test.
 */

export const PROFILE_STEP_M = 5;
export const GRADE_WINDOW_M = 10;
export const GRADE_WINDOW_Z12_M = 24;
/** Grade above which a stretch is steep (amber). */
export const STEEP_GRADE = 0.25;
/** Grade above which a stretch is very steep (red). */
export const VERY_STEEP_GRADE = 0.5;
/** Shorter steep runs are not shown and do not count. */
export const MIN_RUN_M = 10;
/** More than this many metres above 25 % make a route "not recommended". */
export const STEEP_TOTAL_LIMIT_M = 50;
/** Distance to a road centreline below which a point counts as on the road. */
export const OFF_ROAD_NEAR_M = 6;
/** DEM zoom the fine classification needs; coarser data shows at most amber. */
export const FINE_DEM_ZOOM = 14;
/**
 * Margin before and after a bridge over which the heights are bridged too:
 * the DEM's dip under a 35 m bridge starts and ends a few metres past the
 * deck (bilinear 3 m pixels, smoothed banks).
 */
export const BRIDGE_APPROACH_M = 10;
/** A piece runs on a bridge when it is this close to a bridge centreline… */
export const BRIDGE_NEAR_M = 6;
/** …and runs along it within this angle (a line passing under it does not). */
export const BRIDGE_MAX_ANGLE_DEG = 30;

export type SteepClass = 0 | 1 | 2;

/** A run of the route in metres along the polyline. */
export interface RouteSegment {
	from: number;
	to: number;
	offRoad: boolean;
	steep: SteepClass;
	/**
	 * Steepest grade over the run in percent, signed along the line (positive =
	 * uphill from the route's start towards its end); absent without DEM.
	 */
	gradePct?: number;
}

export interface ProfileStations {
	points: GeoPoint[];
	/** Distance along the polyline in metres, per station. */
	s: number[];
	/** Polyline segment index each piece (station i → i+1) lies on. */
	seg: number[];
	total: number;
}

export interface RouteProfile {
	segments: RouteSegment[];
	/** Signed height(last point) − height(first point); `null` without DEM. */
	climbM: number | null;
	metersOver25: number;
	metersOver50: number;
	maxGradePct: number | null;
	/** Metres of the route off roads and paths. */
	offRoadMeters: number;
	/** Station distances and heights (for the pressure rule); heights `null` without DEM. */
	s: number[];
	heights: number[] | null;
}

/** Off-road test per resampled piece: its midpoint and polyline segment index. */
export type OffRoadTest = (midpoint: GeoPoint, polylineSegment: number) => boolean;

/** Bridge test per resampled piece: its two ends. */
export type BridgeTest = (a: GeoPoint, b: GeoPoint) => boolean;

function lerp(a: GeoPoint, b: GeoPoint, f: number): GeoPoint {
	return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

/** Stations every `stepM` along `points`, plus every polyline vertex. */
export function resampleForProfile(points: GeoPoint[], stepM = PROFILE_STEP_M): ProfileStations {
	const out: ProfileStations = { points: [], s: [], seg: [], total: 0 };
	if (points.length === 0) return out;
	out.points.push(points[0]);
	out.s.push(0);
	let walked = 0;
	let nextAt = stepM;
	for (let i = 0; i < points.length - 1; i++) {
		const len = distanceTo(points[i], points[i + 1]);
		if (len === 0) continue;
		while (nextAt < walked + len - 1e-6) {
			out.seg.push(i);
			out.points.push(lerp(points[i], points[i + 1], (nextAt - walked) / len));
			out.s.push(nextAt);
			nextAt += stepM;
		}
		walked += len;
		out.seg.push(i);
		out.points.push(points[i + 1]);
		out.s.push(walked);
		// Restart the step raster at the vertex so pieces stay ≤ stepM.
		nextAt = walked + stepM;
	}
	out.total = walked;
	return out;
}

/**
 * Window grade per piece, signed along the line: the steepest window covering
 * each piece (|grade| decides, the sign is kept).
 */
function pieceGrades(s: number[], h: number[], windowM: number): number[] {
	const pieces = s.length - 1;
	const grades = new Array<number>(Math.max(0, pieces)).fill(0);
	if (pieces <= 0) return grades;
	const total = s[s.length - 1];
	if (total <= 0) return grades;
	const window = Math.min(windowM, total);
	let j = 0;
	for (let i = 0; i < s.length - 1; i++) {
		if (j < i + 1) j = i + 1;
		while (j < s.length - 1 && s[j] - s[i] < window - 1e-6) j++;
		const run = s[j] - s[i];
		if (run <= 0) continue;
		if (run < window - 1e-6 && i > 0) break; // tail windows are covered by earlier ones
		const grade = (h[j] - h[i]) / run;
		for (let k = i; k < j; k++) if (Math.abs(grade) > Math.abs(grades[k])) grades[k] = grade;
	}
	return grades;
}

/**
 * Heights with every bridge (pieces flagged in `onBridge`, grown by
 * {@link BRIDGE_APPROACH_M} along the line) replaced by the straight line
 * between the heights just outside it; at a route end the one outside height
 * is held. Without a bridge the input is returned.
 */
export function deckHeights(s: number[], h: number[], onBridge: boolean[]): number[] {
	if (!onBridge.some(Boolean)) return h;
	const deck = new Array<boolean>(s.length).fill(false);
	for (let k = 0; k < onBridge.length; k++) {
		if (!onBridge[k]) continue;
		const lo = s[k] - BRIDGE_APPROACH_M;
		const hi = s[k + 1] + BRIDGE_APPROACH_M;
		for (let i = 0; i < s.length; i++) if (s[i] >= lo - 1e-6 && s[i] <= hi + 1e-6) deck[i] = true;
	}
	const out = [...h];
	let i = 0;
	while (i < s.length) {
		if (!deck[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < s.length && deck[j + 1]) j++;
		const a = i - 1;
		const b = j + 1 < s.length ? j + 1 : -1;
		for (let k = i; k <= j; k++) {
			if (a >= 0 && b >= 0) {
				const f = s[b] > s[a] ? (s[k] - s[a]) / (s[b] - s[a]) : 0;
				out[k] = h[a] + (h[b] - h[a]) * f;
			} else if (a >= 0) out[k] = h[a];
			else if (b >= 0) out[k] = h[b];
		}
		i = j + 1;
	}
	return out;
}

/** Lowers runs of `cls ≥ level` shorter than {@link MIN_RUN_M} to `level − 1`. */
function dropShortRuns(classes: SteepClass[], lengths: number[], level: 1 | 2): void {
	let i = 0;
	while (i < classes.length) {
		if (classes[i] < level) {
			i++;
			continue;
		}
		let j = i;
		let length = 0;
		while (j < classes.length && classes[j] >= level) length += lengths[j++];
		if (length < MIN_RUN_M - 1e-6) {
			for (let k = i; k < j; k++) {
				if (classes[k] >= level) classes[k] = (level - 1) as SteepClass;
			}
		}
		i = j;
	}
}

/**
 * Classifies a resampled route. `heights` are parallel to `stations.points`
 * (`null` = no DEM: no steep runs, no climb); `demZoom` below
 * {@link FINE_DEM_ZOOM} widens the grade window and caps the class at amber;
 * `isOnBridge` marks the pieces on a bridge, whose grade is taken over
 * {@link deckHeights}.
 */
export function classifyRoute(
	stations: ProfileStations,
	heights: number[] | null,
	options: { demZoom: number | null; isOffRoad: OffRoadTest; isOnBridge?: BridgeTest }
): RouteProfile {
	const { s, points } = stations;
	const pieces = Math.max(0, points.length - 1);
	const lengths: number[] = [];
	for (let k = 0; k < pieces; k++) lengths.push(s[k + 1] - s[k]);

	const coarse = options.demZoom !== null && options.demZoom < FINE_DEM_ZOOM;
	const classes: SteepClass[] = new Array<SteepClass>(pieces).fill(0);
	let maxGrade: number | null = null;
	let grades: number[] | null = null;
	if (heights && heights.length === points.length) {
		const isOnBridge = options.isOnBridge;
		const onBridge = isOnBridge
			? Array.from({ length: pieces }, (_, k) => isOnBridge(points[k], points[k + 1]))
			: [];
		const graded = deckHeights(s, heights, onBridge);
		grades = pieceGrades(s, graded, coarse ? GRADE_WINDOW_Z12_M : GRADE_WINDOW_M);
		maxGrade = grades.reduce((m, g) => Math.max(m, Math.abs(g)), 0);
		for (let k = 0; k < pieces; k++) {
			const g = Math.abs(grades[k]);
			const cls: SteepClass = g > VERY_STEEP_GRADE ? 2 : g > STEEP_GRADE ? 1 : 0;
			classes[k] = coarse ? (Math.min(cls, 1) as SteepClass) : cls;
		}
		dropShortRuns(classes, lengths, 2);
		dropShortRuns(classes, lengths, 1);
	}

	const offRoad: boolean[] = [];
	for (let k = 0; k < pieces; k++) {
		offRoad.push(options.isOffRoad(lerp(points[k], points[k + 1], 0.5), stations.seg[k]));
	}

	const segments: RouteSegment[] = [];
	let metersOver25 = 0;
	let metersOver50 = 0;
	let offRoadMeters = 0;
	for (let k = 0; k < pieces; k++) {
		if (classes[k] >= 1) metersOver25 += lengths[k];
		if (classes[k] >= 2) metersOver50 += lengths[k];
		if (offRoad[k]) offRoadMeters += lengths[k];
		const gradePct = grades ? grades[k] * 100 : undefined;
		const last = segments[segments.length - 1];
		if (last && last.offRoad === offRoad[k] && last.steep === classes[k]) {
			last.to = s[k + 1];
			if (gradePct !== undefined && Math.abs(gradePct) > Math.abs(last.gradePct ?? 0)) {
				last.gradePct = gradePct;
			}
		} else {
			const segment: RouteSegment = {
				from: s[k],
				to: s[k + 1],
				offRoad: offRoad[k],
				steep: classes[k]
			};
			if (gradePct !== undefined) segment.gradePct = gradePct;
			segments.push(segment);
		}
	}

	const hasHeights = heights !== null && heights.length === points.length && points.length > 0;
	return {
		segments,
		climbM: hasHeights ? heights[heights.length - 1] - heights[0] : null,
		metersOver25,
		metersOver50,
		maxGradePct: maxGrade === null ? null : maxGrade * 100,
		offRoadMeters,
		s,
		heights: hasHeights ? heights : null
	};
}

/**
 * 3D length of a profiled line: Σ √(Δs² + Δh²) over its stations (`s` along
 * the 2D line, `heights` parallel). Plan §6.4: the reported metres.
 */
export function length3d(s: number[], heights: number[]): number {
	let total = 0;
	for (let i = 0; i + 1 < s.length; i++)
		total += Math.hypot(s[i + 1] - s[i], heights[i + 1] - heights[i]);
	return total;
}

/** True when the slope alone makes the route "not recommended" (§6.8). */
export function slopeNotRecommended(profile: Pick<RouteProfile, 'metersOver25' | 'metersOver50'>) {
	return profile.metersOver50 > 0 || profile.metersOver25 > STEEP_TOTAL_LIMIT_M;
}

/**
 * The polyline cut into one `LineString` coordinate list per run, for the
 * map layers (`[lng, lat]` pairs).
 */
export function splitByRuns(
	points: GeoPoint[],
	segments: RouteSegment[]
): {
	coordinates: [number, number][];
	offRoad: boolean;
	steep: SteepClass;
	from: number;
	to: number;
}[] {
	const cum: number[] = [0];
	for (let i = 0; i < points.length - 1; i++)
		cum.push(cum[i] + distanceTo(points[i], points[i + 1]));
	const at = (d: number): GeoPoint => {
		for (let i = 0; i < points.length - 1; i++) {
			if (d <= cum[i + 1] || i === points.length - 2) {
				const len = cum[i + 1] - cum[i];
				return len > 0 ? lerp(points[i], points[i + 1], (d - cum[i]) / len) : points[i];
			}
		}
		return points[points.length - 1];
	};
	return segments.map((segment) => {
		const coordinates: [number, number][] = [];
		const start = at(segment.from);
		coordinates.push([start.lng, start.lat]);
		for (let i = 1; i < points.length - 1; i++) {
			if (cum[i] > segment.from && cum[i] < segment.to) {
				coordinates.push([points[i].lng, points[i].lat]);
			}
		}
		const end = at(segment.to);
		coordinates.push([end.lng, end.lat]);
		return {
			coordinates,
			offRoad: segment.offRoad,
			steep: segment.steep,
			from: segment.from,
			to: segment.to
		};
	});
}

const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LNG_AT_EQUATOR = 111320;

/**
 * Distance in metres from `point` to the segment a–b, in a local
 * equirectangular frame centred on the point.
 */
function distanceToSegmentMeters(
	point: GeoPoint,
	a: [number, number],
	b: [number, number]
): number {
	const kx = Math.cos((point.lat * Math.PI) / 180) * METERS_PER_DEG_LNG_AT_EQUATOR;
	const ax = (a[0] - point.lng) * kx;
	const ay = (a[1] - point.lat) * METERS_PER_DEG_LAT;
	const dx = (b[0] - point.lng) * kx - ax;
	const dy = (b[1] - point.lat) * METERS_PER_DEG_LAT - ay;
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
	return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * True when `point` lies within `maxDistanceM` of any road centreline (each
 * road's bbox, grown by the distance, is a cheap prefilter).
 */
export function isNearAnyRoad(
	point: GeoPoint,
	roads: RoadLine[],
	maxDistanceM: number = OFF_ROAD_NEAR_M
): boolean {
	const latGrow = maxDistanceM / METERS_PER_DEG_LAT;
	const lngGrow =
		maxDistanceM / (METERS_PER_DEG_LNG_AT_EQUATOR * Math.cos((point.lat * Math.PI) / 180));
	for (const road of roads) {
		const [west, south, east, north] = road.bbox;
		if (
			point.lng < west - lngGrow ||
			point.lng > east + lngGrow ||
			point.lat < south - latGrow ||
			point.lat > north + latGrow
		) {
			continue;
		}
		for (let i = 0; i < road.points.length - 1; i++) {
			if (distanceToSegmentMeters(point, road.points[i], road.points[i + 1]) <= maxDistanceM) {
				return true;
			}
		}
	}
	return false;
}

/**
 * True when the piece a–b runs on one of `bridges`: its midpoint within
 * {@link BRIDGE_NEAR_M} of a bridge segment and its direction within
 * {@link BRIDGE_MAX_ANGLE_DEG} of that segment's (a line passing under the
 * bridge crosses it and does not count).
 */
export function isAlongBridge(a: GeoPoint, b: GeoPoint, bridges: RoadLine[]): boolean {
	const mid = lerp(a, b, 0.5);
	const kx = Math.cos((mid.lat * Math.PI) / 180) * METERS_PER_DEG_LNG_AT_EQUATOR;
	const px = (b.lng - a.lng) * kx;
	const py = (b.lat - a.lat) * METERS_PER_DEG_LAT;
	const pieceLength = Math.hypot(px, py);
	const minCos = Math.cos((BRIDGE_MAX_ANGLE_DEG * Math.PI) / 180);
	const latGrow = BRIDGE_NEAR_M / METERS_PER_DEG_LAT;
	const lngGrow = BRIDGE_NEAR_M / kx;
	for (const bridge of bridges) {
		const [west, south, east, north] = bridge.bbox;
		if (
			mid.lng < west - lngGrow ||
			mid.lng > east + lngGrow ||
			mid.lat < south - latGrow ||
			mid.lat > north + latGrow
		) {
			continue;
		}
		for (let i = 0; i < bridge.points.length - 1; i++) {
			const p = bridge.points[i];
			const q = bridge.points[i + 1];
			if (distanceToSegmentMeters(mid, p, q) > BRIDGE_NEAR_M) continue;
			if (pieceLength === 0) return true;
			const qx = (q[0] - p[0]) * kx;
			const qy = (q[1] - p[1]) * METERS_PER_DEG_LAT;
			const bridgeLength = Math.hypot(qx, qy);
			if (bridgeLength === 0) continue;
			const cos = Math.abs(px * qx + py * qy) / (pieceLength * bridgeLength);
			if (cos >= minCos) return true;
		}
	}
	return false;
}
