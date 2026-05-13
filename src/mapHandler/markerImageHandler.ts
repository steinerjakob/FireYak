// Image source types
export type ImageSource = 'wikimedia' | 'panoramax' | 'mapillary';

// The unified image info structure used across all sources
export interface ImageInfo {
	// Original file details
	url: string;
	width: number;
	height: number;
	// Thumbnail details
	thumburl: string;
	thumbwidth: number;
	thumbheight: number;
	// Source metadata
	source: ImageSource;
	descriptionurl?: string;
	descriptionshorturl?: string;
	size?: number;
	/** ISO 8601 capture / upload date, used for sorting newest-first */
	capturedAt?: string;
}

// ---------------------------------------------------------------------------
// MediaWiki / Wikimedia Commons
// ---------------------------------------------------------------------------

export interface WikiPage {
	pageid: number;
	title: string;
	imageinfo: (Omit<ImageInfo, 'source' | 'capturedAt'> & {
		descriptionshorturl: string;
		descriptionurl: string;
		size: number;
		timestamp?: string;
	})[];
}

interface WikiApiResponse {
	query?: {
		pages: {
			[key: string]: WikiPage;
		};
	};
	error?: {
		code: string;
		info: string;
	};
}

/**
 * Fetches a list of files from MediaWiki Commons matching a specific prefix
 * and retrieves image information, including a thumbnail of the specified width.
 */
export async function fetchMediaWikiFiles(markerId: number): Promise<ImageInfo[]> {
	const prefix = `Fire-fighting-facility node-${markerId}`;
	const encodedPrefix = encodeURIComponent(prefix);
	const apiUrl = 'https://commons.wikimedia.org/w/api.php';
	const thumbnailWidth = 200;

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

		if (data.query?.pages) {
			const results: ImageInfo[] = [];
			for (const page of Object.values(data.query.pages)) {
				for (const info of page.imageinfo) {
					results.push({
						url: info.url,
						width: info.width,
						height: info.height,
						thumburl: info.thumburl,
						thumbwidth: info.thumbwidth,
						thumbheight: info.thumbheight,
						descriptionurl: info.descriptionurl,
						descriptionshorturl: info.descriptionshorturl,
						size: info.size,
						source: 'wikimedia',
						capturedAt: info.timestamp
					});
				}
			}
			return results;
		}

		return [];
	} catch (error) {
		console.error('Error fetching MediaWiki data:', error);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Panoramax
// ---------------------------------------------------------------------------

interface PanoramaxFeature {
	type: 'Feature';
	id: string;
	geometry: {
		type: 'Point';
		coordinates: [number, number];
	};
	properties: {
		datetime?: string;
		[key: string]: unknown;
	};
	assets: {
		hd?: { href: string; type?: string };
		sd?: { href: string; type?: string };
		thumb?: { href: string; type?: string };
	};
}

/**
 * Fetches a single picture from the Panoramax API by its UUID.
 * The UUID comes from the OSM tag `panoramax` on the marker node.
 */
export async function fetchPanoramaxImages(panoramaxId: string): Promise<ImageInfo[]> {
	const apiUrl = `https://api.panoramax.xyz/api/pictures/${encodeURIComponent(panoramaxId)}`;

	try {
		const response = await fetch(apiUrl);

		if (!response.ok) {
			// 404 means the ID doesn't exist or is a sequence ID — skip silently
			if (response.status === 404) return [];
			throw new Error(`Panoramax API HTTP error: ${response.status}`);
		}

		const feature: PanoramaxFeature = await response.json();

		const fullUrl = feature.assets?.hd?.href ?? feature.assets?.sd?.href;
		const thumbUrl = feature.assets?.thumb?.href ?? fullUrl;

		if (!fullUrl) return [];

		return [
			{
				url: fullUrl,
				// Panoramax images are typically equirectangular (2:1) or standard photos.
				// We use 0 as sentinel values; PhotoSwipe will determine actual size on load.
				width: 0,
				height: 0,
				thumburl: thumbUrl ?? fullUrl,
				thumbwidth: 200,
				thumbheight: 150,
				source: 'panoramax',
				descriptionurl: `https://api.panoramax.xyz/#focus=pic&pic=${panoramaxId}`,
				capturedAt: feature.properties?.datetime
			}
		];
	} catch (error) {
		console.error('Error fetching Panoramax data:', error);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Mapillary
// ---------------------------------------------------------------------------

interface MapillaryImageResponse {
	id: string;
	thumb_2048_url?: string;
	thumb_256_url?: string;
	thumb_1024_url?: string;
	width?: number;
	height?: number;
	/** Unix timestamp in milliseconds */
	captured_at?: number;
}

/**
 * Fetches image data from the Mapillary Graph API v4 using the image key
 * stored in the OSM `mapillary` tag and the `VITE_MAPILLARY_ACCESS_TOKEN`
 * environment variable.
 *
 * Falls back to an embed URL when no token is configured.
 */
export async function fetchMapillaryImages(mapillaryKey: string): Promise<ImageInfo[]> {
	const accessToken = import.meta.env.VITE_MAPILLARY_ACCESS_TOKEN as string | undefined;

	if (!accessToken) {
		// No token configured — silently skip Mapillary so it doesn't affect
		// Panoramax or Wikimedia Commons images shown to the user.
		return [];
	}

	const apiUrl = `https://graph.mapillary.com/${encodeURIComponent(mapillaryKey)}?fields=id,thumb_2048_url,thumb_256_url,width,height,captured_at&access_token=${encodeURIComponent(accessToken)}`;

	try {
		const response = await fetch(apiUrl);

		if (!response.ok) {
			if (response.status === 404) return [];
			throw new Error(`Mapillary API HTTP error: ${response.status}`);
		}

		const data: MapillaryImageResponse = await response.json();

		const fullUrl = data.thumb_2048_url;
		const thumbUrl = data.thumb_256_url ?? fullUrl;

		if (!fullUrl) return [];

		return [
			{
				url: fullUrl,
				width: data.width ?? 0,
				height: data.height ?? 0,
				thumburl: thumbUrl ?? fullUrl,
				thumbwidth: 256,
				thumbheight: 171,
				source: 'mapillary',
				descriptionurl: `https://www.mapillary.com/app/?image_key=${encodeURIComponent(mapillaryKey)}`,
				capturedAt: data.captured_at ? new Date(data.captured_at).toISOString() : undefined
			}
		];
	} catch (error) {
		console.error('Error fetching Mapillary data:', error);
		return [];
	}
}
