/**
 * The small status badges drawn on top of a water-source icon (issue #118):
 * a red ✕ for out of service, an amber ! for caution. Drawn on a canvas at
 * runtime, so the map and the nearby list share one source without extra image
 * assets, and the map gets a crisp high-DPI image.
 */
import type { SourceStatus } from '@/helper/operationalStatus';

export type BadgeStatus = Exclude<SourceStatus, 'ok'>;

/** MapLibre image id per status. */
export const STATUS_BADGE_IMAGE: Record<BadgeStatus, string> = {
	outOfService: 'status-out-of-service',
	caution: 'status-caution'
};

/** Rendered size of the badge in CSS pixels. */
export const STATUS_BADGE_CSS_PX = 20;
/** Device pixels per CSS pixel the badge is drawn at. */
export const STATUS_BADGE_PIXEL_RATIO = 3;

const COLORS: Record<BadgeStatus, { fill: string; mark: string }> = {
	outOfService: { fill: '#d32f2f', mark: '#ffffff' },
	caution: { fill: '#f9a825', mark: '#212121' }
};

function drawBadge(status: BadgeStatus): HTMLCanvasElement {
	const size = STATUS_BADGE_CSS_PX * STATUS_BADGE_PIXEL_RATIO;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.scale(STATUS_BADGE_PIXEL_RATIO, STATUS_BADGE_PIXEL_RATIO);
	const c = STATUS_BADGE_CSS_PX / 2;
	const { fill, mark } = COLORS[status];

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
	if (status === 'outOfService') {
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

const canvasCache = new Map<BadgeStatus, HTMLCanvasElement>();
const dataUrlCache = new Map<BadgeStatus, string>();

function badgeCanvas(status: BadgeStatus): HTMLCanvasElement {
	let canvas = canvasCache.get(status);
	if (!canvas) {
		canvas = drawBadge(status);
		canvasCache.set(status, canvas);
	}
	return canvas;
}

/** Pixel data for `map.addImage(id, data, { pixelRatio: STATUS_BADGE_PIXEL_RATIO })`. */
export function statusBadgeImageData(status: BadgeStatus): ImageData {
	const canvas = badgeCanvas(status);
	return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}

/** Data URL of the badge for an `<img>` (nearby list). */
export function statusBadgeDataUrl(status: BadgeStatus): string {
	let url = dataUrlCache.get(status);
	if (!url) {
		url = badgeCanvas(status).toDataURL('image/png');
		dataUrlCache.set(status, url);
	}
	return url;
}
