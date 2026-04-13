import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

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
 * Converts a Blob to a base64 string (without data URL prefix).
 */
function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const dataUrl = reader.result as string;
			// Strip the "data:...;base64," prefix
			resolve(dataUrl.split(',')[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

/**
 * Writes a Blob to a temporary file in the app's cache directory.
 * Returns the file URI that can be used with CapacitorHttp.
 */
async function writeTempFile(blob: Blob, filename: string): Promise<string> {
	const base64Data = await blobToBase64(blob);
	const result = await Filesystem.writeFile({
		path: `wikimedia-upload/${filename}`,
		data: base64Data,
		directory: Directory.Cache,
		recursive: true
	});
	return result.uri;
}

/**
 * Removes a temporary file written for upload.
 */
async function removeTempFile(path: string): Promise<void> {
	try {
		await Filesystem.deleteFile({
			path: `wikimedia-upload/${path}`,
			directory: Directory.Cache
		});
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Fetches a CSRF token from the Wikimedia Commons API.
 * Required for authenticated write operations (upload, edit).
 *
 * On native platforms, uses CapacitorHttp to bypass CORS restrictions.
 */
export async function getCsrfToken(accessToken: string): Promise<string> {
	if (Capacitor.isNativePlatform()) {
		const response = await CapacitorHttp.get({
			url: COMMONS_API_URL,
			params: {
				action: 'query',
				meta: 'tokens',
				type: 'csrf',
				format: 'json'
			},
			headers: {
				Authorization: `Bearer ${accessToken}`
			}
		});

		const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
		const token = data?.query?.tokens?.csrftoken;

		if (!token) {
			throw new Error('No CSRF token in response');
		}

		return token;
	}

	// Web: use fetch with origin=* for CORS
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
 * Uploads a file to Wikimedia Commons.
 *
 * On web: uses XMLHttpRequest for progress tracking.
 * On native: uses CapacitorHttp with a temp file to bypass CORS.
 *   Progress tracking is not available on native (onProgress won't be called).
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
	if (Capacitor.isNativePlatform()) {
		return uploadFileNative(params);
	}
	return uploadFileWeb(params);
}

/**
 * Native upload implementation using CapacitorHttp + Filesystem.
 * Writes the blob to a temp file, uploads via native HTTP, then cleans up.
 */
async function uploadFileNative(params: {
	accessToken: string;
	filename: string;
	file: Blob;
	description: string;
	comment: string;
	csrfToken: string;
	onProgress?: (percent: number) => void;
}): Promise<UploadResult> {
	const { accessToken, filename, file, description, comment, csrfToken } = params;

	const tempFilename = `upload-${Date.now()}.jpg`;
	const fileUri = await writeTempFile(file, tempFilename);

	try {
		const response = await CapacitorHttp.post({
			url: COMMONS_API_URL,
			headers: {
				'Content-Type': 'multipart/form-data',
				Authorization: `Bearer ${accessToken}`
			},
			data: {
				action: 'upload',
				format: 'json',
				filename,
				text: description,
				comment,
				token: csrfToken,
				ignorewarnings: '1',
				file: [fileUri, 'image/jpeg', filename]
			}
		});

		const data =
			typeof response.data === 'string'
				? (JSON.parse(response.data) as UploadResult)
				: (response.data as UploadResult);

		if (data.upload?.result === 'Success') {
			return data;
		} else {
			throw new Error(`Upload failed: ${data.upload?.result || 'Unknown error'}`);
		}
	} finally {
		await removeTempFile(tempFilename);
	}
}

/**
 * Web upload implementation using XMLHttpRequest for progress tracking.
 */
function uploadFileWeb(params: {
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
 *
 * On native platforms, uses CapacitorHttp to bypass CORS restrictions.
 */
export async function queryExistingFiles(osmId: number): Promise<string[]> {
	const prefix = `Fire-fighting-facility node-${osmId}`;

	if (Capacitor.isNativePlatform()) {
		const response = await CapacitorHttp.get({
			url: COMMONS_API_URL,
			params: {
				action: 'query',
				format: 'json',
				generator: 'allpages',
				gapnamespace: '6',
				gapprefix: prefix,
				gaplimit: '20'
			}
		});

		const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

		if (!data.query?.pages) {
			return [];
		}

		return Object.values(data.query.pages as Record<string, { title: string }>).map(
			(page) => page.title
		);
	}

	// Web: use fetch with origin=* for CORS
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
