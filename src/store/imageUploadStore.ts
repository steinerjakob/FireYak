import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { useWikimediaAuthStore } from '@/store/wikimediaAuthStore';
import { useSettingsStore } from '@/store/settingsStore';
import { fetchMediaWikiFiles, type WikiPage } from '@/mapHandler/markerImageHandler';
import {
	getCsrfToken,
	compressImage,
	uploadFile,
	queryExistingFiles,
	getNextFilename,
	getImageDescription
} from '@/helper/wikimediaApi';
import { version } from '../../package.json';

const MAX_IMAGES_PER_MARKER = 5;
const MAX_FILE_SIZE_MB = 20;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;

export interface SelectedImage {
	webPath: string;
	blob: Blob;
	name: string;
}

export const useImageUploadStore = defineStore('imageUpload', () => {
	const selectedImages = ref<SelectedImage[]>([]);
	const uploadProgress = ref(0);
	const currentUploadIndex = ref(0);
	const isUploading = ref(false);
	const existingImages = ref<WikiPage[]>([]);
	const uploadError = ref<string | null>(null);

	const canAddMore = computed(
		() => existingImages.value.length + selectedImages.value.length < MAX_IMAGES_PER_MARKER
	);

	const remainingSlots = computed(
		() => MAX_IMAGES_PER_MARKER - existingImages.value.length - selectedImages.value.length
	);

	const totalImages = computed(() => existingImages.value.length + selectedImages.value.length);

	/**
	 * Opens the Capacitor Camera picker to select an image.
	 * Validates dimensions and file size, then compresses the image.
	 */
	async function selectImage(): Promise<void> {
		if (!canAddMore.value) {
			throw new Error(`Maximum of ${MAX_IMAGES_PER_MARKER} images per marker reached`);
		}

		const photo = await Camera.getPhoto({
			quality: 80,
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

		// Compress the image
		const compressedBlob = await compressImage(originalBlob);

		// Validate file size after compression
		const sizeMB = compressedBlob.size / (1024 * 1024);
		if (sizeMB > MAX_FILE_SIZE_MB) {
			throw new Error(
				`Image too large after compression: ${sizeMB.toFixed(1)} MB. Maximum is ${MAX_FILE_SIZE_MB} MB.`
			);
		}

		selectedImages.value.push({
			webPath: photo.webPath,
			blob: compressedBlob,
			name: `image-${Date.now()}.jpg`
		});
	}

	/**
	 * Removes a selected image by index.
	 */
	function removeSelectedImage(index: number): void {
		if (index >= 0 && index < selectedImages.value.length) {
			selectedImages.value.splice(index, 1);
		}
	}

	/**
	 * Uploads all selected images to Wikimedia Commons.
	 * Gets tokens, resolves filenames, and uploads sequentially with progress tracking.
	 */
	async function uploadAll(osmId: number): Promise<void> {
		if (selectedImages.value.length === 0) {
			return;
		}

		const wikimediaAuth = useWikimediaAuthStore();
		const settingsStore = useSettingsStore();

		if (!wikimediaAuth.isAuthenticated || !wikimediaAuth.user) {
			throw new Error('Not authenticated with Wikimedia Commons');
		}

		const accessToken = settingsStore.wikimediaAccessToken;
		if (!accessToken) {
			throw new Error('No Wikimedia access token available');
		}

		isUploading.value = true;
		uploadError.value = null;
		uploadProgress.value = 0;
		currentUploadIndex.value = 0;

		try {
			const csrfToken = await getCsrfToken(accessToken);
			const existing = await queryExistingFiles(osmId);

			// Track filenames as we upload to calculate the next suffix correctly
			const allFilenames = [...existing];

			for (let i = 0; i < selectedImages.value.length; i++) {
				currentUploadIndex.value = i;
				const image = selectedImages.value[i];

				const filename = getNextFilename(osmId, allFilenames);
				const description = getImageDescription(osmId, wikimediaAuth.user.name, version);

				await uploadFile({
					accessToken,
					filename,
					file: image.blob,
					description,
					comment: `Upload fire-fighting facility image via FireYak ${version}`,
					csrfToken,
					onProgress: (percent) => {
						// Distribute progress across all images
						const baseProgress = (i / selectedImages.value.length) * 100;
						const imageContribution = (percent / 100) * (100 / selectedImages.value.length);
						uploadProgress.value = Math.round(baseProgress + imageContribution);
					}
				});

				// Add the uploaded filename so the next iteration calculates correctly
				allFilenames.push(`File:${filename}`);
			}

			uploadProgress.value = 100;

			// Clear selected images on success
			selectedImages.value = [];
		} catch (error) {
			uploadError.value = error instanceof Error ? error.message : 'Upload failed unexpectedly';
			throw error;
		} finally {
			isUploading.value = false;
		}
	}

	/**
	 * Loads existing images for a marker from Wikimedia Commons.
	 * Uses the existing fetchMediaWikiFiles function from markerImageHandler.
	 */
	async function loadExistingImages(osmId: number): Promise<void> {
		existingImages.value = await fetchMediaWikiFiles(osmId);
	}

	/**
	 * Resets all store state to initial values.
	 */
	function reset(): void {
		selectedImages.value = [];
		uploadProgress.value = 0;
		currentUploadIndex.value = 0;
		isUploading.value = false;
		existingImages.value = [];
		uploadError.value = null;
	}

	return {
		MAX_IMAGES_PER_MARKER,
		// State
		selectedImages,
		uploadProgress,
		currentUploadIndex,
		isUploading,
		existingImages,
		uploadError,

		// Computed
		canAddMore,
		remainingSlots,
		totalImages,

		// Actions
		selectImage,
		removeSelectedImage,
		uploadAll,
		loadExistingImages,
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
