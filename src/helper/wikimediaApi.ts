const COMMONS_API_URL =
	import.meta.env.VITE_COMMONS_API_URL || 'https://commons.wikimedia.org/w/api.php';

export interface UploadResult {
	upload: {
		result: string;
		filename?: string;
		imageinfo?: {
			url: string;
			descriptionurl: string;
		};
	};
}

/**
 * Fetches a CSRF token from the Wikimedia Commons API.
 * Required for authenticated write operations (upload, edit).
 */
export async function getCsrfToken(accessToken: string): Promise<string> {
	const url = `${COMMONS_API_URL}?action=query&meta=tokens&type=csrf&format=json&origin=*`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch CSRF token (${response.status})`);
	}

	const data = await response.json();
	const token = data?.query?.tokens?.csrftoken;

	if (!token) {
		throw new Error('No CSRF token in response');
	}

	return token;
}

/**
 * Compresses and resizes an image blob using the canvas API.
 * Maintains aspect ratio, scaling the longest side to maxWidth.
 * Re-encodes as JPEG at the given quality level.
 */
export async function compressImage(
	blob: Blob,
	maxWidth: number = 2048,
	quality: number = 0.8
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(blob);

		img.onload = () => {
			URL.revokeObjectURL(url);

			let { width, height } = img;

			// Scale down if either dimension exceeds maxWidth
			if (width > maxWidth || height > maxWidth) {
				if (width >= height) {
					height = Math.round((height / width) * maxWidth);
					width = maxWidth;
				} else {
					width = Math.round((width / height) * maxWidth);
					height = maxWidth;
				}
			}

			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;

			const ctx = canvas.getContext('2d');
			if (!ctx) {
				reject(new Error('Failed to get canvas 2D context'));
				return;
			}

			ctx.drawImage(img, 0, 0, width, height);

			canvas.toBlob(
				(result) => {
					if (result) {
						resolve(result);
					} else {
						reject(new Error('Canvas toBlob returned null'));
					}
				},
				'image/jpeg',
				quality
			);
		};

		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Failed to load image for compression'));
		};

		img.src = url;
	});
}

/**
 * Uploads a file to Wikimedia Commons using XMLHttpRequest for progress tracking.
 */
export function uploadFile(params: {
	accessToken: string;
	filename: string;
	file: Blob;
	description: string;
	comment: string;
	csrfToken: string;
	onProgress?: (percent: number) => void;
}): Promise<UploadResult> {
	const { accessToken, filename, file, description, comment, csrfToken, onProgress } = params;

	return new Promise((resolve, reject) => {
		const formData = new FormData();
		formData.append('action', 'upload');
		formData.append('format', 'json');
		formData.append('origin', '*');
		formData.append('filename', filename);
		formData.append('text', description);
		formData.append('comment', comment);
		formData.append('token', csrfToken);
		formData.append('file', file, filename);
		formData.append('ignorewarnings', '1');

		const xhr = new XMLHttpRequest();

		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable && onProgress) {
				const percent = Math.round((event.loaded / event.total) * 100);
				onProgress(percent);
			}
		};

		xhr.onload = () => {
			try {
				const data: UploadResult = JSON.parse(xhr.responseText);
				if (data.upload?.result === 'Success') {
					resolve(data);
				} else {
					reject(new Error(`Upload failed: ${data.upload?.result || 'Unknown error'}`));
				}
			} catch {
				reject(new Error(`Failed to parse upload response: ${xhr.responseText}`));
			}
		};

		xhr.onerror = () => {
			reject(new Error('Network error during upload'));
		};

		xhr.open('POST', COMMONS_API_URL);
		xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
		xhr.send(formData);
	});
}

/**
 * Queries Wikimedia Commons for existing files matching the OSM node prefix.
 * No authentication required (public query).
 */
export async function queryExistingFiles(osmId: number): Promise<string[]> {
	const prefix = `Fire-fighting-facility node-${osmId}`;
	const encodedPrefix = encodeURIComponent(prefix);
	const url = `${COMMONS_API_URL}?action=query&format=json&generator=allpages&gapnamespace=6&gapprefix=${encodedPrefix}&gaplimit=20&origin=*`;

	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Failed to query existing files (${response.status})`);
	}

	const data = await response.json();

	if (!data.query?.pages) {
		return [];
	}

	return Object.values(data.query.pages as Record<string, { title: string }>).map(
		(page) => page.title
	);
}

/**
 * Determines the next filename for an OSM node based on existing files.
 * First file: `Fire-fighting-facility node-<osmId>.jpg`
 * Subsequent: `Fire-fighting-facility node-<osmId> <N>.jpg`
 */
export function getNextFilename(osmId: number, existingFiles: string[]): string {
	const base = `Fire-fighting-facility node-${osmId}`;

	if (existingFiles.length === 0) {
		return `${base}.jpg`;
	}

	// Find the highest numeric suffix among existing files
	let maxSuffix = 1; // The first file (without suffix) counts as 1

	for (const file of existingFiles) {
		// Strip the "File:" prefix if present
		const name = file.replace(/^File:/, '');

		// Match pattern: base + optional " <number>" + extension
		const regex = new RegExp(
			`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+(\\d+))?\\.\\w+$`
		);
		const match = name.match(regex);

		if (match) {
			const suffix = match[1] ? parseInt(match[1], 10) : 1;
			if (suffix > maxSuffix) {
				maxSuffix = suffix;
			}
		}
	}

	return `${base} ${maxSuffix + 1}.jpg`;
}

/**
 * Generates the wikitext description for an uploaded image.
 * Follows Wikimedia Commons file description conventions.
 */
export function getImageDescription(osmId: number, username: string, version: string): string {
	const uploadDate = new Date().toISOString().split('T')[0];

	return `=={{int:filedesc}}==
{{Information
|description={{en|1=Fire-fighting facility documented by FireYak ${version}. OSM Node ID: ${osmId}}}
|date=${uploadDate}
|source={{own}} — uploaded with [https://app.fireyak.org FireYak] ${version}
|author=[[User:${username}|${username}]]
}}

=={{int:license-header}}==
{{cc-by-sa-4.0|${username}}}

[[Category:Fire hydrants]]
[[Category:Uploaded with FireYak]]`;
}
