import { OsmRef, parseRef } from '@/helper/osmRef';

/** The photo providers FireYak can pull marker images from. */
export type ImageSource = 'wikimedia' | 'panoramax';

/**
 * One photo, normalised across every provider. Wikimedia Commons is the only
 * source that fills in all of the optional metadata; Panoramax populates what
 * its API returns and leaves the rest undefined.
 */
export interface ImageInfo {
	// Original file details
	url: string;
	width: number;
	height: number;
	// Thumbnail details
	thumburl: string;
	thumbwidth: number;
	thumbheight: number;
	/** Which provider this photo came from — drives the badge in the viewer. */
	source: ImageSource;
	/** Public page for the photo, shown as an attribution link in the viewer. */
	descriptionurl?: string;
	descriptionshorturl?: string;
	size?: number;
	/** ISO 8601 capture / upload date, used to sort newest-first within a source. */
	capturedAt?: string;
}

/**
 * Guards every URL that reaches an `<img src>` or an `<a href>` in the viewer.
 * Both providers hand back URLs we did not construct, and one of them is
 * reached via an id that comes straight out of a user-editable OSM tag, so a
 * `javascript:` or `data:` URL must never make it through.
 *
 * HTTPS only: both APIs serve everything over TLS, so a cleartext URL in a
 * response is a downgrade rather than a case to support. Dropping it here also
 * keeps native builds (where the app origin is not itself https) from loading
 * a photo in the clear.
 */
function isHttpsUrl(url: string | undefined): url is string {
	if (!url) return false;
	try {
		return new URL(url).protocol === 'https:';
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// MediaWiki / Wikimedia Commons
// ---------------------------------------------------------------------------

interface WikiImageInfo {
	url: string;
	size: number;
	width: number;
	height: number;
	descriptionshorturl: string;
	descriptionurl: string;
	thumburl: string;
	thumbwidth: number;
	thumbheight: number;
	/** ISO 8601 upload timestamp (requested via `iiprop=…|timestamp`). */
	timestamp?: string;
}

interface WikiPage {
	pageid: number;
	title: string;
	imageinfo?: WikiImageInfo[];
}

interface WikiApiResponse {
	query?: {
		pages: {
			[key: string]: WikiPage; // Keys are page IDs
		};
	};
	error?: {
		code: string;
		info: string;
	};
}

/**
 * Fetches files from MediaWiki Commons matching the FireYak naming convention
 * and retrieves image information, including a thumbnail of a fixed width.
 *
 * The Commons category convention (`Fire-fighting-facility node-<id>`) is
 * node-only — there is no equivalent for ways — so this skips the request
 * entirely for a way ref rather than querying a category that cannot exist.
 *
 * @param ref The marker's namespaced OSM ref.
 * @returns A promise that resolves to the photos found, or `[]` on any failure.
 */
export async function fetchMediaWikiFiles(ref: OsmRef): Promise<ImageInfo[]> {
	const parsed = parseRef(ref);
	if (parsed?.type !== 'node') {
		return [];
	}

	const prefix = `Fire-fighting-facility node-${parsed.id}`;
	const encodedPrefix = encodeURIComponent(prefix);
	const apiUrl = 'https://commons.wikimedia.org/w/api.php';
	const thumbnailWidth = 200;

	// Construct the full URL with all necessary parameters
	const url = `${apiUrl}?action=query&format=json&generator=allpages&gapnamespace=6&gapprefix=${encodedPrefix}&prop=imageinfo&iiprop=url|size|dimensions|mime|thumburl|timestamp&iiurlwidth=${thumbnailWidth}&gaplimit=10&origin=*`;

	try {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data: WikiApiResponse = await response.json();

		if (data.error) {
			throw new Error(`MediaWiki API error: ${data.error.info}`);
		}

		// Flatten the complex 'pages' object into normalised photo entries
		const images: ImageInfo[] = [];
		for (const page of Object.values(data.query?.pages ?? {})) {
			for (const info of page.imageinfo ?? []) {
				if (!isHttpsUrl(info.url)) continue;
				images.push({
					url: info.url,
					width: info.width,
					height: info.height,
					thumburl: isHttpsUrl(info.thumburl) ? info.thumburl : info.url,
					thumbwidth: info.thumbwidth,
					thumbheight: info.thumbheight,
					source: 'wikimedia',
					descriptionurl: isHttpsUrl(info.descriptionurl) ? info.descriptionurl : undefined,
					descriptionshorturl: info.descriptionshorturl,
					size: info.size,
					capturedAt: info.timestamp
				});
			}
		}
		return images;
	} catch (error) {
		console.error('Error fetching MediaWiki data:', error);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Panoramax
// ---------------------------------------------------------------------------

const PANORAMAX_API = 'https://api.panoramax.xyz';

/**
 * The `panoramax` OSM tag holds a picture UUID. Anything else — a sequence id,
 * a full URL, a typo — cannot be resolved by the pictures endpoint, so it is
 * rejected before a request is made rather than after a 404. This doubles as
 * the sanitiser for the two places the id is interpolated into a URL.
 */
const PANORAMAX_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Panoramax picture as returned by the API (a STAC Item). */
interface PanoramaxFeature {
	type: 'Feature';
	id: string;
	properties?: {
		datetime?: string;
		[key: string]: unknown;
	};
	assets?: {
		hd?: { href?: string };
		sd?: { href?: string };
		thumb?: { href?: string };
	};
}

/**
 * Fetches a single picture from the Panoramax API by the UUID stored in the
 * OSM `panoramax` tag.
 *
 * Panoramax does not report pixel dimensions on the picture item, so `width`
 * and `height` are left at 0; the viewer resolves them by preloading the image
 * before it hands the slide to PhotoSwipe.
 */
export async function fetchPanoramaxImages(panoramaxId: string): Promise<ImageInfo[]> {
	if (!PANORAMAX_ID_PATTERN.test(panoramaxId)) {
		return [];
	}

	try {
		const response = await fetch(`${PANORAMAX_API}/api/pictures/${panoramaxId}`);

		if (!response.ok) {
			// 404 means the id doesn't exist on this instance — skip silently
			if (response.status === 404) return [];
			throw new Error(`Panoramax API HTTP error: ${response.status}`);
		}

		const feature: PanoramaxFeature = await response.json();

		const fullUrl = [feature.assets?.hd?.href, feature.assets?.sd?.href].find(isHttpsUrl);
		if (!fullUrl) return [];

		const thumbUrl = feature.assets?.thumb?.href;

		return [
			{
				url: fullUrl,
				// Unknown until the image is loaded — see the doc comment above.
				width: 0,
				height: 0,
				thumburl: isHttpsUrl(thumbUrl) ? thumbUrl : fullUrl,
				thumbwidth: 200,
				thumbheight: 150,
				source: 'panoramax',
				descriptionurl: `${PANORAMAX_API}/#focus=pic&pic=${panoramaxId}`,
				capturedAt: feature.properties?.datetime
			}
		];
	} catch (error) {
		console.error('Error fetching Panoramax data:', error);
		return [];
	}
}
