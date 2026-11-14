/**
 * Downhill static-pressure rule for hose lines (plan §6.13).
 *
 * With a closed branch (the worst case, no flow) the pressure at the lowest
 * point of a line is the source pressure plus 0.1 bar per metre of drop below
 * the source. It is compared with the hose's maximum working pressure:
 * "check pressure" from 75 %, "not recommended" from 100 %.
 *
 * Pure module: no store, map or network dependencies.
 */

/** Default maximum working pressure of pressure hoses (DIN 14811), in bar. */
export const DEFAULT_MAX_HOSE_PRESSURE_BAR = 16;
/** Hydrostatic pressure per metre of water column, in bar. */
export const BAR_PER_METRE = 0.1;
/** Share of the maximum from which the line gets a "check pressure" note. */
export const CAUTION_SHARE = 0.75;

export type PressureLevel = 'ok' | 'caution' | 'warning';

/** Numeric `fire_hydrant:pressure` in bar, or `null` ("suction", 0, absent). */
export function parseHydrantPressure(tags: Record<string, string> | undefined): number | null {
	const raw = tags?.['fire_hydrant:pressure'];
	if (!raw) return null;
	const value = parseFloat(raw);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The stored `maxHosePressure` preference as a number. Installs without the
 * setting (everyone before it existed) and unusable values get the default.
 */
export function parseStoredMaxHosePressure(raw: string | null | undefined): number {
	if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_MAX_HOSE_PRESSURE_BAR;
	const value = parseFloat(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_HOSE_PRESSURE_BAR;
}

/** Level for a static pressure against the hose maximum. */
export function pressureLevelFor(staticBar: number, maxBar: number): PressureLevel {
	const eps = 1e-9;
	if (staticBar >= maxBar - eps) return 'warning';
	if (staticBar >= CAUTION_SHARE * maxBar - eps) return 'caution';
	return 'ok';
}

/** One stretch of line fed by one source: heights from the source downstream. */
export interface PressureStretch {
	/** Heights in metres; `heights[0]` is the source (pump or hydrant). */
	heights: number[];
	/** Pressure at the source in bar. */
	sourceBar: number;
}

export interface PressureResult {
	/** Highest static pressure at any stretch's lowest point, in bar. */
	staticPressureMaxBar: number;
	level: PressureLevel;
}

/**
 * Evaluates the rule over every stretch and returns the worst. A stretch that
 * never drops below its source adds nothing (uphill lines are handled by the
 * pump calculation). `null` when no stretch has heights.
 */
export function evaluateDownhillPressure(
	stretches: PressureStretch[],
	maxBar: number
): PressureResult | null {
	let worst: PressureResult | null = null;
	for (const { heights, sourceBar } of stretches) {
		if (heights.length === 0) continue;
		const hSource = heights[0];
		let hMin = hSource;
		for (const h of heights) if (h < hMin) hMin = h;
		const drop = hSource - hMin;
		const staticBar = sourceBar + BAR_PER_METRE * drop;
		const level: PressureLevel = drop > 0 ? pressureLevelFor(staticBar, maxBar) : 'ok';
		const rank = { ok: 0, caution: 1, warning: 2 };
		if (
			!worst ||
			rank[level] > rank[worst.level] ||
			(rank[level] === rank[worst.level] && staticBar > worst.staticPressureMaxBar)
		) {
			worst = { staticPressureMaxBar: staticBar, level };
		}
	}
	return worst;
}

/**
 * Splits a profile (distances `s`, heights `h`, source at `s = 0`) at the given
 * pump positions into stretches. `cuts` are ascending distances along the line
 * with the pressure the pump there feeds in.
 */
export function stretchesAlongLine(
	s: number[],
	h: number[],
	sourceBar: number,
	cuts: { atM: number; sourceBar: number }[] = []
): PressureStretch[] {
	const bounds = [{ atM: 0, sourceBar }, ...cuts];
	const stretches: PressureStretch[] = [];
	for (let b = 0; b < bounds.length; b++) {
		const from = bounds[b].atM;
		const to = b + 1 < bounds.length ? bounds[b + 1].atM : Infinity;
		const heights: number[] = [];
		for (let i = 0; i < s.length; i++) {
			if (s[i] >= from - 1e-6 && s[i] <= to + 1e-6) heights.push(h[i]);
		}
		if (heights.length > 0) stretches.push({ heights, sourceBar: bounds[b].sourceBar });
	}
	return stretches;
}
