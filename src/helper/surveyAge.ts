import { emergencyOf, WATER_SOURCE_TYPES } from '@/helper/operationalStatus';

/**
 * How long ago a water source was last checked on site (issue #120). Pure:
 * tags and today in, age bucket out.
 *
 * OSM's `survey:date` is the date a mapper last saw the feature in person; the
 * wiki (Tag:emergency=fire_hydrant) says it does NOT mean a functional check.
 * So this tells how fresh the map data is, not whether the hydrant works, and
 * the UI says "last checked on site", never "inspected". `check_date` (the
 * general "data last reviewed" key StreetComplete writes) counts as well: the
 * newer of the two wins.
 *
 * Fixed thresholds, the same everywhere: a yearly check is the most common
 * recommendation (fire brigades, DIN 14462 for site hydrants, AWWA M17), and
 * data older than two years is clearly stale. Official inspection intervals
 * differ by country but measure something else (utility inspections), so they
 * do not apply to this tag.
 *
 * - `recent`: within the last 12 months
 * - `older`: 12 to 24 months ago (both anniversaries included)
 * - `stale`: more than 24 months ago
 * - `none`: no valid date (missing, partial, impossible or in the future): no badge
 */
export type SurveyAge = 'recent' | 'older' | 'stale' | 'none';

/** The buckets that get a badge, in legend order. */
export const SURVEY_AGE_BADGES = ['recent', 'older', 'stale'] as const;
export type SurveyAgeBadge = (typeof SURVEY_AGE_BADGES)[number];

export const SURVEY_DATE_KEYS = ['survey:date', 'check_date'] as const;

/** Months after which a check is no longer `recent`, and no longer `older`. */
export const SURVEY_RECENT_MONTHS = 12;
export const SURVEY_STALE_MONTHS = 24;

type Tags = Record<string, string> | undefined;

/** `YYYY-MM-DD` as a sortable number (`20261126`), or null when not a real day. */
export function parseSurveyDate(value: string | undefined): number | null {
	const match = value?.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const [year, month, day] = match.slice(1).map(Number);
	if (year === 0 || month < 1 || month > 12 || day < 1) return null;
	if (day > daysInMonth(year, month)) return null;
	return year * 10000 + month * 100 + day;
}

function daysInMonth(year: number, month: number): number {
	// Day 0 of the next month is the last day of this one (UTC: no DST shifts).
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The local calendar day `months` before `today`, as a sortable number; the day
 * is clamped to the target month's length (29 Feb minus 12 months is 28 Feb).
 */
function monthsBefore(today: Date, months: number): number {
	const total = today.getFullYear() * 12 + today.getMonth() - months;
	const year = Math.floor(total / 12);
	const month = (total % 12) + 1;
	const day = Math.min(today.getDate(), daysInMonth(year, month));
	return year * 10000 + month * 100 + day;
}

/** The newest valid date among `survey:date` and `check_date`, or null. */
export function lastSurveyDate(tags: Tags): number | null {
	let newest: number | null = null;
	for (const key of SURVEY_DATE_KEYS) {
		const date = parseSurveyDate(tags?.[key]);
		if (date !== null && (newest === null || date > newest)) newest = date;
	}
	return newest;
}

/** Age bucket of the last on-site check, against the local calendar day `today`. */
export function surveyAge(tags: Tags, today: Date = new Date()): SurveyAge {
	const date = lastSurveyDate(tags);
	if (date === null || date > monthsBefore(today, 0)) return 'none';
	if (date > monthsBefore(today, SURVEY_RECENT_MONTHS)) return 'recent';
	return date >= monthsBefore(today, SURVEY_STALE_MONTHS) ? 'older' : 'stale';
}

/**
 * The survey badge a marker gets, or null: only water sources (in service or
 * not; fire stations never) with a valid past date get one.
 */
export function surveyBadge(tags: Tags, today: Date = new Date()): SurveyAgeBadge | null {
	const type = emergencyOf(tags);
	if (!type || !(WATER_SOURCE_TYPES as readonly string[]).includes(type)) return null;
	const age = surveyAge(tags, today);
	return age === 'none' ? null : age;
}
