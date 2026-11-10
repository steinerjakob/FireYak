import { GeoPoint, distanceTo } from '@/types/geo';

/**
 * Steepness and off-road classification of a hose route (plan §6.8), shared by
 * every routing mode. The route is resampled every {@link PROFILE_STEP_M}; a
 * stretch is "steep" when some {@link GRADE_WINDOW_M} window over it rises or
 * falls more than 25 %, "very steep" above 50 %. Runs shorter than
 * {@link MIN_RUN_M} are dropped. With only the coarse z12 DEM the grade is
 * taken over {@link GRADE_WINDOW_Z12_M} and at most "steep" is shown.
 *
 * Pure module: heights and the off-road test come from the caller.
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

export type SteepClass = 0 | 1 | 2;

/** A run of the route in metres along the polyline. */
export interface RouteSegment {
	from: number;
	to: number;
	offRoad: boolean;
	steep: SteepClass;
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

/** Window grade (0..∞) per station start: the steepest window covering each piece. */
function pieceGrades(s: number[], h: number[], windowM: number): number[] {
	const pieces = s.length - 1;
	const grades = new Array<number>(pieces).fill(0);
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
		const grade = Math.abs(h[j] - h[i]) / run;
		for (let k = i; k < j; k++) if (grade > grades[k]) grades[k] = grade;
	}
	return grades;
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
 * {@link FINE_DEM_ZOOM} widens the grade window and caps the class at amber.
 */
export function classifyRoute(
	stations: ProfileStations,
	heights: number[] | null,
	options: { demZoom: number | null; isOffRoad: OffRoadTest }
): RouteProfile {
	const { s, points } = stations;
	const pieces = Math.max(0, points.length - 1);
	const lengths: number[] = [];
	for (let k = 0; k < pieces; k++) lengths.push(s[k + 1] - s[k]);

	const coarse = options.demZoom !== null && options.demZoom < FINE_DEM_ZOOM;
	const classes: SteepClass[] = new Array<SteepClass>(pieces).fill(0);
	let maxGrade: number | null = null;
	if (heights && heights.length === points.length) {
		const grades = pieceGrades(s, heights, coarse ? GRADE_WINDOW_Z12_M : GRADE_WINDOW_M);
		maxGrade = grades.reduce((m, g) => Math.max(m, g), 0);
		for (let k = 0; k < pieces; k++) {
			const g = grades[k];
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
		const last = segments[segments.length - 1];
		if (last && last.offRoad === offRoad[k] && last.steep === classes[k]) {
			last.to = s[k + 1];
		} else {
			segments.push({ from: s[k], to: s[k + 1], offRoad: offRoad[k], steep: classes[k] });
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
): { coordinates: [number, number][]; offRoad: boolean; steep: SteepClass }[] {
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
		return { coordinates, offRoad: segment.offRoad, steep: segment.steep };
	});
}
