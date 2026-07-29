import { OsmRef, parseRef } from '@/helper/osmRef';

// The MediaWiki API structure
export interface ImageInfo {
	// Original file details
	url: string;
	size: number;
	width: number;
	height: number;
	descriptionshorturl: string;
	descriptionurl: string;
	// Thumbnail details
	thumburl: string;
	thumbwidth: number;
	thumbheight: number;
}

export interface WikiPage {
	pageid: number;
	title: string;
	imageinfo: ImageInfo[];
}

interface ApiResponse {
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
 * Fetches a list of files from MediaWiki Commons matching a specific prefix
 * and retrieves image information, including a thumbnail of the specified width.
 *
 * The Commons category convention (`Fire-fighting-facility node-<id>`) is
 * node-only — there is no equivalent for ways — so this skips the request
 * entirely for a way ref rather than querying a category that cannot exist.
 *
 * @returns A promise that resolves to an array of file objects.
 * @param ref
 */
export async function fetchMediaWikiFiles(ref: OsmRef): Promise<WikiPage[]> {
	const parsed = parseRef(ref);
	if (parsed?.type !== 'node') {
		return [];
	}

	const prefix = `Fire-fighting-facility node-${parsed.id}`;
	const encodedPrefix = encodeURIComponent(prefix);
	const apiUrl = 'https://commons.wikimedia.org/w/api.php';
	const thumbnailWidth = 200;

	// Construct the full URL with all necessary parameters
	const url = `${apiUrl}?action=query&format=json&generator=allpages&gapnamespace=6&gapprefix=${encodedPrefix}&prop=imageinfo&iiprop=url|size|dimensions|mime|thumburl&iiurlwidth=${thumbnailWidth}&gaplimit=10&origin=*`;

	try {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data: ApiResponse = await response.json();

		if (data.error) {
			throw new Error(`MediaWiki API error: ${data.error.info}`);
		}

		// Process the complex 'pages' object into a clean array
		if (data.query?.pages) {
			return Object.values(data.query.pages);
		}

		// Return an empty array if no files were found
		return [];
	} catch (error) {
		console.error('Error fetching MediaWiki data:', error);
		return [];
	}
}
