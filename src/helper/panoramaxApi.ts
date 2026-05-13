import { Capacitor, CapacitorHttp } from '@capacitor/core';
import piexif from 'piexifjs';

const PANORAMAX_API_URL = 'https://panoramax.openstreetmap.fr/api';

export interface PictureUploadResult {
	id: string;
}

export interface UploadSetResult {
	id: string;
}

/**
 * Compresses and resizes an image blob using the canvas API.
 * Maintains aspect ratio, scaling the longest side to maxWidth.
 * Re-encodes as JPEG at the given quality level.
 * Note: canvas compression strips EXIF data — use injectExifGps() afterwards.
 */
export async function compressImage(
	blob: Blob,
	maxWidth: number = 2048,
	quality: number = 0.85
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
 * Converts decimal degrees to DMS (degrees, minutes, seconds) rational array
 * as required by the EXIF GPS format used by piexifjs.
 */
function decimalToDmsRational(
	decimal: number
): [[number, number], [number, number], [number, number]] {
	const d = Math.abs(decimal);
	const degrees = Math.floor(d);
	const minutesFloat = (d - degrees) * 60;
	const minutes = Math.floor(minutesFloat);
	const secondsFloat = (minutesFloat - minutes) * 60;
	// Use 100 as denominator for seconds precision
	const seconds = Math.round(secondsFloat * 100);

	return [
		[degrees, 1],
		[minutes, 1],
		[seconds, 100]
	];
}

/**
 * Injects GPS coordinates into a JPEG blob's EXIF metadata using piexifjs.
 * Panoramax requires GPS EXIF data to accept uploads.
 * Canvas compression strips all EXIF, so this must be called after compressImage().
 *
 * @param blob    JPEG blob (already compressed via canvas)
 * @param lat     Latitude in decimal degrees (positive = North)
 * @param lon     Longitude in decimal degrees (positive = East)
 */
export async function injectExifGps(blob: Blob, lat: number, lon: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onload = () => {
			try {
				const dataUrl = reader.result as string;

				// Build minimal GPS EXIF data
				const gpsIfd: Record<number, unknown> = {
					[piexif.GPSIFD.GPSLatitudeRef]: lat >= 0 ? 'N' : 'S',
					[piexif.GPSIFD.GPSLatitude]: decimalToDmsRational(lat),
					[piexif.GPSIFD.GPSLongitudeRef]: lon >= 0 ? 'E' : 'W',
					[piexif.GPSIFD.GPSLongitude]: decimalToDmsRational(lon)
				};

				const exifObj = { GPS: gpsIfd };
				const exifStr = piexif.dump(exifObj);
				const newDataUrl = piexif.insert(exifStr, dataUrl);

				// Convert data URL back to Blob
				const base64 = newDataUrl.split(',')[1];
				const binary = atob(base64);
				const array = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) {
					array[i] = binary.charCodeAt(i);
				}

				resolve(new Blob([array], { type: 'image/jpeg' }));
			} catch (error) {
				reject(new Error(`Failed to inject GPS EXIF: ${error}`));
			}
		};

		reader.onerror = () => reject(new Error('Failed to read blob for EXIF injection'));
		reader.readAsDataURL(blob);
	});
}

/**
 * Creates a new upload set on Panoramax OSM-FR.
 * An upload set is a session container for one or more picture uploads.
 * Must be completed via completeUploadSet() after uploading all pictures.
 */
export async function createUploadSet(token: string): Promise<string> {
	if (Capacitor.isNativePlatform()) {
		const response = await CapacitorHttp.post({
			url: `${PANORAMAX_API_URL}/upload_sets`,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			data: {}
		});

		const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

		if (!data?.id) {
			throw new Error(`Failed to create upload set: ${JSON.stringify(data)}`);
		}

		return data.id as string;
	}

	const response = await fetch(`${PANORAMAX_API_URL}/upload_sets`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({})
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to create upload set (${response.status}): ${text}`);
	}

	const data = await response.json();

	if (!data?.id) {
		throw new Error(`No id in upload set response: ${JSON.stringify(data)}`);
	}

	return data.id as string;
}

/**
 * Uploads a single picture to an existing upload set.
 * Returns the picture UUID that can be stored as the `panoramax` OSM tag.
 *
 * Uses XMLHttpRequest on all platforms (with upload progress support).
 * On native, Capacitor's CapacitorHttp.enabled=true patches XHR to handle FormData/Blob.
 */
export function uploadPicture(params: {
	token: string;
	uploadSetId: string;
	file: Blob;
	onProgress?: (percent: number) => void;
}): Promise<string> {
	const { token, uploadSetId, file, onProgress } = params;

	return new Promise((resolve, reject) => {
		const formData = new FormData();
		formData.append('picture', file, 'photo.jpg');

		const xhr = new XMLHttpRequest();

		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable && onProgress) {
				const percent = Math.round((event.loaded / event.total) * 100);
				onProgress(percent);
			}
		};

		xhr.onload = () => {
			try {
				const data = JSON.parse(xhr.responseText);

				if (xhr.status < 200 || xhr.status >= 300) {
					console.error('[panoramaxApi] Upload error response:', data);
					reject(
						new Error(
							`Upload failed (${xhr.status}): ${data?.detail || data?.message || 'Unknown error'}`
						)
					);
					return;
				}

				const pictureId = data?.id;
				if (!pictureId) {
					console.error('[panoramaxApi] No picture id in response:', data);
					reject(new Error('No picture id returned from upload'));
					return;
				}

				resolve(pictureId as string);
			} catch {
				console.error(
					'[panoramaxApi] Failed to parse upload response:',
					xhr.responseText?.substring(0, 500)
				);
				reject(new Error('Failed to parse upload response'));
			}
		};

		xhr.onerror = () => {
			reject(new Error('Network error during picture upload'));
		};

		xhr.open('POST', `${PANORAMAX_API_URL}/upload_sets/${uploadSetId}/items`);
		xhr.setRequestHeader('Authorization', `Bearer ${token}`);
		xhr.send(formData);
	});
}

/**
 * Completes an upload set, triggering server-side processing
 * (blurring, tiling, federation indexing).
 * The picture UUID is already available before calling this.
 */
export async function completeUploadSet(token: string, uploadSetId: string): Promise<void> {
	if (Capacitor.isNativePlatform()) {
		const response = await CapacitorHttp.post({
			url: `${PANORAMAX_API_URL}/upload_sets/${uploadSetId}/complete`,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			data: {}
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Failed to complete upload set (${response.status})`);
		}

		return;
	}

	const response = await fetch(`${PANORAMAX_API_URL}/upload_sets/${uploadSetId}/complete`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({})
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to complete upload set (${response.status}): ${text}`);
	}
}

/**
 * Verifies the Panoramax token is still valid by calling the /me endpoint.
 * Returns user info object on success, throws on failure.
 */
export async function fetchPanoramaxUser(token: string): Promise<{ sub: string; name?: string }> {
	if (Capacitor.isNativePlatform()) {
		const response = await CapacitorHttp.get({
			url: `${PANORAMAX_API_URL}/auth/me`,
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Panoramax user fetch failed (${response.status})`);
		}

		const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
		return data as { sub: string; name?: string };
	}

	const response = await fetch(`${PANORAMAX_API_URL}/auth/me`, {
		headers: {
			Authorization: `Bearer ${token}`
		}
	});

	if (!response.ok) {
		throw new Error(`Panoramax user fetch failed (${response.status})`);
	}

	return response.json() as Promise<{ sub: string; name?: string }>;
}
