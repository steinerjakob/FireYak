/**
 * The small badges drawn on top of a water-source icon: a red ✕ for out of
 * service, an amber ! for caution (issue #118), and a clock for how long ago
 * the source was last checked on site (issue #120; green, amber, red). Drawn
 * on a canvas at runtime, so the map and the nearby list share one source
 * without extra image assets, and the map gets a crisp high-DPI image.
 *
 * Placement (map and nearby list): the status badge sits top-right; the clock
 * takes top-right when there is no status badge, else top-left.
 */
import type { SourceStatus } from '@/helper/operationalStatus';
import type { SurveyAgeBadge } from '@/helper/surveyAge';

export type BadgeStatus = Exclude<SourceStatus, 'ok'>;

/** MapLibre image id per status. */
export const STATUS_BADGE_IMAGE: Record<BadgeStatus, string> = {
	outOfService: 'status-out-of-service',
	caution: 'status-caution'
};

/** MapLibre image id per survey age. */
export const SURVEY_BADGE_IMAGE: Record<SurveyAgeBadge, string> = {
	recent: 'survey-recent',
	older: 'survey-older',
	stale: 'survey-stale'
};

/** Rendered size of the badge in CSS pixels. */
export const STATUS_BADGE_CSS_PX = 20;
/** Device pixels per CSS pixel the badge is drawn at. */
export const STATUS_BADGE_PIXEL_RATIO = 3;

type BadgeKind = BadgeStatus | SurveyAgeBadge;

const COLORS: Record<BadgeKind, { fill: string; mark: string }> = {
	outOfService: { fill: '#d32f2f', mark: '#ffffff' },
	caution: { fill: '#f9a825', mark: '#212121' },
	recent: { fill: '#2e7d32', mark: '#ffffff' },
	older: { fill: '#f9a825', mark: '#212121' },
	stale: { fill: '#d32f2f', mark: '#ffffff' }
};

function drawBadge(kind: BadgeKind): HTMLCanvasElement {
	const size = STATUS_BADGE_CSS_PX * STATUS_BADGE_PIXEL_RATIO;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.scale(STATUS_BADGE_PIXEL_RATIO, STATUS_BADGE_PIXEL_RATIO);
	const c = STATUS_BADGE_CSS_PX / 2;
	const { fill, mark } = COLORS[kind];

	// White ring keeps the badge readable on the icon, dark map and satellite.
	ctx.beginPath();
	ctx.arc(c, c, c - 0.5, 0, Math.PI * 2);
	ctx.fillStyle = '#ffffff';
	ctx.fill();
	const inner = c - 2;
	ctx.beginPath();
	ctx.arc(c, c, inner, 0, Math.PI * 2);
	ctx.fillStyle = fill;
	ctx.fill();

	// The mark is sized from the inner circle and kept well inside it, so it
	// reads as a symbol on a disc rather than filling the badge edge to edge.
	ctx.strokeStyle = mark;
	ctx.fillStyle = mark;
	ctx.lineCap = 'round';
	ctx.lineWidth = inner * 0.26;
	if (kind === 'recent' || kind === 'older' || kind === 'stale') {
		// Clock: a thin dial and two hands (at 12 and 3), lighter than the ✕
		// and ! so it reads as information next to them, not as a warning.
		ctx.lineWidth = inner * 0.16;
		ctx.beginPath();
		ctx.arc(c, c, inner * 0.62, 0, Math.PI * 2);
		ctx.stroke();
		ctx.lineWidth = inner * 0.18;
		ctx.beginPath();
		ctx.moveTo(c, c - inner * 0.38);
		ctx.lineTo(c, c);
		ctx.lineTo(c + inner * 0.28, c);
		ctx.stroke();
	} else if (kind === 'outOfService') {
		const d = inner * 0.3;
		ctx.beginPath();
		ctx.moveTo(c - d, c - d);
		ctx.lineTo(c + d, c + d);
		ctx.moveTo(c + d, c - d);
		ctx.lineTo(c - d, c + d);
		ctx.stroke();
	} else {
		ctx.beginPath();
		ctx.moveTo(c, c - inner * 0.45);
		ctx.lineTo(c, c + inner * 0.1);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(c, c + inner * 0.42, inner * 0.14, 0, Math.PI * 2);
		ctx.fill();
	}
	return canvas;
}

const canvasCache = new Map<BadgeKind, HTMLCanvasElement>();
const dataUrlCache = new Map<BadgeKind, string>();

function badgeCanvas(kind: BadgeKind): HTMLCanvasElement {
	let canvas = canvasCache.get(kind);
	if (!canvas) {
		canvas = drawBadge(kind);
		canvasCache.set(kind, canvas);
	}
	return canvas;
}

function badgeImageData(kind: BadgeKind): ImageData {
	const canvas = badgeCanvas(kind);
	return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}

function badgeDataUrl(kind: BadgeKind): string {
	let url = dataUrlCache.get(kind);
	if (!url) {
		url = badgeCanvas(kind).toDataURL('image/png');
		dataUrlCache.set(kind, url);
	}
	return url;
}

/** Pixel data for `map.addImage(id, data, { pixelRatio: STATUS_BADGE_PIXEL_RATIO })`. */
export function statusBadgeImageData(status: BadgeStatus): ImageData {
	return badgeImageData(status);
}

/** Data URL of the badge for an `<img>` (nearby list). */
export function statusBadgeDataUrl(status: BadgeStatus): string {
	return badgeDataUrl(status);
}

/** Pixel data of the survey clock, like `statusBadgeImageData`. */
export function surveyBadgeImageData(age: SurveyAgeBadge): ImageData {
	return badgeImageData(age);
}

/** Data URL of the survey clock for an `<img>` (nearby list, legend). */
export function surveyBadgeDataUrl(age: SurveyAgeBadge): string {
	return badgeDataUrl(age);
}
