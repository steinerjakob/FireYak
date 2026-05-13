import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { usePanoramaxAuthStore } from '@/store/panoramaxAuthStore';
import {
	compressImage,
	injectExifGps,
	createUploadSet,
	uploadPicture,
	completeUploadSet
} from '@/helper/panoramaxApi';

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const MAX_FILE_SIZE_MB = 50;

export interface SelectedImage {
	webPath: string;
	blob: Blob;
	name: string;
}

export const useImageUploadStore = defineStore('imageUpload', () => {
	const selectedImage = ref<SelectedImage | null>(null);
	const uploadProgress = ref(0);
	const isUploading = ref(false);
	const uploadError = ref<string | null>(null);

	const hasSelectedImage = computed(() => selectedImage.value !== null);

	/**
	 * Opens the Capacitor Camera picker to select an image.
	 * Validates dimensions and file size, then compresses the image.
	 */
	async function selectImage(): Promise<void> {
		const photo = await Camera.getPhoto({
			quality: 85,
			width: 2048,
			resultType: CameraResultType.Uri,
			source: CameraSource.Prompt
		});

		if (!photo.webPath) {
			throw new Error('No image path returned from camera');
		}

		// Fetch the URI to get a Blob
		const response = await fetch(photo.webPath);
		const originalBlob = await response.blob();

		// Validate dimensions by loading as an Image
		const dimensions = await getImageDimensions(photo.webPath);
		if (dimensions.width < MIN_WIDTH || dimensions.height < MIN_HEIGHT) {
			throw new Error(
				`Image too small: ${dimensions.width}×${dimensions.height}. Minimum is ${MIN_WIDTH}×${MIN_HEIGHT}.`
			);
		}

		// Compress the image (this strips EXIF — GPS will be re-injected before upload)
		const compressedBlob = await compressImage(originalBlob);

		// Validate file size after compression
		const sizeMB = compressedBlob.size / (1024 * 1024);
		if (sizeMB > MAX_FILE_SIZE_MB) {
			throw new Error(
				`Image too large after compression: ${sizeMB.toFixed(1)} MB. Maximum is ${MAX_FILE_SIZE_MB} MB.`
			);
		}

		selectedImage.value = {
			webPath: photo.webPath,
			blob: compressedBlob,
			name: `photo-${Date.now()}.jpg`
		};
	}

	/**
	 * Clears the currently selected image.
	 */
	function removeSelectedImage(): void {
		selectedImage.value = null;
	}

	/**
	 * Uploads the selected image to Panoramax OSM-FR.
	 * Injects GPS EXIF from the marker's lat/lon before uploading
	 * (canvas compression strips EXIF, so injection is mandatory).
	 *
	 * Returns the picture UUID to be stored as the `panoramax` OSM tag.
	 */
	async function uploadImage(lat: number, lon: number): Promise<string> {
		if (!selectedImage.value) {
			throw new Error('No image selected');
		}

		const panoramaxAuth = usePanoramaxAuthStore();

		if (!panoramaxAuth.isAuthenticated) {
			throw new Error('Not authenticated with Panoramax');
		}

		const token = await panoramaxAuth.getToken();
		if (!token) {
			throw new Error('No Panoramax token available');
		}

		isUploading.value = true;
		uploadError.value = null;
		uploadProgress.value = 0;

		try {
			// Step 1: Inject GPS EXIF into the compressed image using marker coordinates
			uploadProgress.value = 5;
			const imageWithGps = await injectExifGps(selectedImage.value.blob, lat, lon);

			// Step 2: Create an upload set (session container)
			uploadProgress.value = 10;
			const uploadSetId = await createUploadSet(token);

			// Step 3: Upload the picture and get its UUID
			uploadProgress.value = 20;
			const pictureId = await uploadPicture({
				token,
				uploadSetId,
				file: imageWithGps,
				onProgress: (percent) => {
					// Map upload progress 20% → 90%
					uploadProgress.value = 20 + Math.round(percent * 0.7);
				}
			});

			// Step 4: Complete the upload set (triggers processing/blurring)
			// Note: the picture UUID is already available — OSM tagging can happen now
			uploadProgress.value = 95;
			// Fire-and-forget: completing the set is important but the UUID is already locked in
			completeUploadSet(token, uploadSetId).catch((err) => {
				console.warn('[imageUploadStore] Failed to complete upload set:', err);
			});

			uploadProgress.value = 100;
			selectedImage.value = null;

			return pictureId;
		} catch (error) {
			uploadError.value = error instanceof Error ? error.message : 'Upload failed unexpectedly';
			throw error;
		} finally {
			isUploading.value = false;
		}
	}

	/**
	 * Resets all store state to initial values.
	 */
	function reset(): void {
		selectedImage.value = null;
		uploadProgress.value = 0;
		isUploading.value = false;
		uploadError.value = null;
	}

	return {
		// State
		selectedImage,
		uploadProgress,
		isUploading,
		uploadError,

		// Computed
		hasSelectedImage,

		// Actions
		selectImage,
		removeSelectedImage,
		uploadImage,
		reset
	};
});

/**
 * Loads an image from a URL and returns its natural dimensions.
 */
function getImageDimensions(url: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const img = new Image();

		img.onload = () => {
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};

		img.onerror = () => {
			reject(new Error('Failed to load image for dimension check'));
		};

		img.src = url;
	});
}
