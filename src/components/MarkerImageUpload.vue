<script setup lang="ts">
import {
	IonItem,
	IonLabel,
	IonButton,
	IonIcon,
	IonNote,
	IonItemGroup,
	IonItemDivider,
	IonProgressBar,
	IonSpinner,
	alertController,
	toastController
} from '@ionic/vue';
import { cameraOutline, closeCircle, trashOutline } from 'ionicons/icons';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useImageUploadStore } from '@/store/imageUploadStore';
import { usePanoramaxAuthStore } from '@/store/panoramaxAuthStore';
import { useMarkerEditStore } from '@/store/markerEditStore';
import { fetchPanoramaxImages } from '@/mapHandler/markerImageHandler';

const imageUploadStore = useImageUploadStore();
const panoramaxAuthStore = usePanoramaxAuthStore();
const markerEditStore = useMarkerEditStore();
const { t } = useI18n();

const previewLoading = ref(false);
const previewError = ref(false);
const existingImageUrl = ref<string | null>(null);

// The existing panoramax tag on the marker being edited (if any)
const existingPanoramaxId = computed(
	() => markerEditStore.originalMarker?.tags?.['panoramax'] ?? null
);

// Whether the user has removed the existing panoramax image in this edit session
// (i.e., the panoramax tag was present originally but is now cleared in editableTags)
const isPanoramaxDetached = computed(
	() => existingPanoramaxId.value !== null && !markerEditStore.editableTags['panoramax']
);

// Reset image upload store when editing is deactivated
watch(
	() => markerEditStore.isActive,
	(active) => {
		if (!active) {
			imageUploadStore.reset();
			existingImageUrl.value = null;
		}
	}
);

// Fetch the actual Panoramax thumbnail URL when the panoramax ID is available
watch(
	existingPanoramaxId,
	async (id) => {
		existingImageUrl.value = null;
		previewError.value = false;

		if (!id) {
			previewLoading.value = false;
			return;
		}

		previewLoading.value = true;
		try {
			const images = await fetchPanoramaxImages(id);
			if (images.length > 0 && images[0].thumburl) {
				existingImageUrl.value = images[0].thumburl;
			} else {
				previewError.value = true;
			}
		} catch {
			previewError.value = true;
		} finally {
			previewLoading.value = false;
		}
	},
	{ immediate: true }
);

const showAuthAlert = async () => {
	const alert = await alertController.create({
		header: t('panoramaxAuth.authDialog.title'),
		message: t('panoramaxAuth.authDialog.message'),
		buttons: [
			{
				text: t('common.cancel'),
				role: 'cancel'
			},
			{
				text: t('panoramaxAuth.buttons.login'),
				handler: () => {
					panoramaxAuthStore.login();
				}
			}
		]
	});
	await alert.present();
};

const handleAddImage = async () => {
	// Check authentication with Panoramax
	if (!panoramaxAuthStore.isAuthenticated) {
		await showAuthAlert();
		return;
	}

	// Select image from camera/gallery
	try {
		await imageUploadStore.selectImage();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const toast = await toastController.create({
			message,
			duration: 3000,
			color: 'danger'
		});
		await toast.present();
	}
};

/**
 * Detaches the existing Panoramax image from this marker.
 * Removes the `panoramax` tag from editableTags — the old image
 * remains on the Panoramax server but is no longer linked to this node.
 */
const handleDetachImage = async () => {
	const alert = await alertController.create({
		header: t('imageUpload.detach.title'),
		message: t('imageUpload.detach.message'),
		buttons: [
			{
				text: t('common.cancel'),
				role: 'cancel'
			},
			{
				text: t('imageUpload.detach.confirm'),
				role: 'destructive',
				handler: () => {
					markerEditStore.updateTag('panoramax', '');
				}
			}
		]
	});
	await alert.present();
};

const retryUpload = async () => {
	imageUploadStore.uploadError = null;
};
</script>

<template>
	<ion-item-group>
		<ion-item-divider>
			<ion-label> 📷 {{ t('imageUpload.title') }} </ion-label>
		</ion-item-divider>

		<!-- Existing Panoramax image linked to this marker -->
		<template
			v-if="existingPanoramaxId && !isPanoramaxDetached && !imageUploadStore.hasSelectedImage"
		>
			<ion-item lines="none">
				<ion-label class="ion-text-wrap">
					<p>{{ t('imageUpload.existingImage') }}</p>
				</ion-label>
			</ion-item>
			<div class="image-preview">
				<div class="existing-thumbnail-wrapper">
					<ion-spinner v-if="previewLoading" name="crescent" class="preview-spinner" />
					<img
						v-if="existingImageUrl && !previewLoading"
						:src="existingImageUrl"
						:alt="t('imageUpload.existingImage')"
					/>
					<p v-if="previewError && !previewLoading" class="preview-fallback">
						<small>ID: {{ existingPanoramaxId }}</small>
					</p>
				</div>
			</div>
			<ion-item lines="none">
				<ion-button fill="outline" color="primary" @click="handleAddImage()">
					<ion-icon slot="start" :icon="cameraOutline"></ion-icon>
					{{ t('imageUpload.replaceImage') }}
				</ion-button>
				<ion-button slot="end" fill="clear" color="danger" @click="handleDetachImage()">
					<ion-icon slot="start" :icon="trashOutline"></ion-icon>
					{{ t('imageUpload.detachImage') }}
				</ion-button>
			</ion-item>
		</template>

		<!-- Detached state: panoramax tag removed in this edit session -->
		<template v-else-if="isPanoramaxDetached && !imageUploadStore.hasSelectedImage">
			<ion-item lines="none">
				<ion-label>
					<p>{{ t('imageUpload.imageDetached') }}</p>
				</ion-label>
			</ion-item>
			<ion-item lines="none">
				<ion-button fill="outline" color="primary" @click="handleAddImage()">
					<ion-icon slot="start" :icon="cameraOutline"></ion-icon>
					{{ t('imageUpload.addImage') }}
				</ion-button>
			</ion-item>
		</template>

		<!-- New image selected for upload -->
		<template v-else-if="imageUploadStore.hasSelectedImage">
			<ion-item lines="none">
				<ion-label>{{ t('imageUpload.newImage') }}</ion-label>
			</ion-item>
			<div class="image-preview">
				<div class="thumbnail-wrapper">
					<img
						:src="imageUploadStore.selectedImage!.webPath"
						:alt="imageUploadStore.selectedImage!.name"
					/>
					<ion-button
						class="remove-btn"
						fill="clear"
						size="small"
						color="danger"
						@click="imageUploadStore.removeSelectedImage()"
					>
						<ion-icon slot="icon-only" :icon="closeCircle"></ion-icon>
					</ion-button>
				</div>
			</div>
		</template>

		<!-- No image: add button (no existing image and none selected) -->
		<template v-else>
			<ion-item lines="none">
				<ion-button fill="outline" color="primary" @click="handleAddImage()">
					<ion-icon slot="start" :icon="cameraOutline"></ion-icon>
					{{ t('imageUpload.addImage') }}
				</ion-button>
			</ion-item>
			<ion-item v-if="!panoramaxAuthStore.isAuthenticated" lines="none">
				<ion-note color="medium" class="ion-text-wrap">
					{{ t('panoramaxAuth.loginHint') }}
				</ion-note>
			</ion-item>
		</template>

		<!-- Upload progress -->
		<ion-item v-if="imageUploadStore.isUploading" lines="none">
			<ion-label>
				{{ t('imageUpload.uploading') }}
			</ion-label>
		</ion-item>
		<ion-item v-if="imageUploadStore.isUploading" lines="none">
			<ion-progress-bar :value="imageUploadStore.uploadProgress / 100"></ion-progress-bar>
		</ion-item>

		<!-- Upload error with retry -->
		<ion-item v-if="imageUploadStore.uploadError" lines="none">
			<ion-label color="danger" class="ion-text-wrap">
				{{ imageUploadStore.uploadError }}
			</ion-label>
			<ion-button slot="end" size="small" @click="retryUpload()">
				{{ t('imageUpload.retryUpload') }}
			</ion-button>
		</ion-item>
	</ion-item-group>
</template>

<style scoped>
.image-preview {
	display: flex;
	padding: 8px 16px;
}

.thumbnail-wrapper {
	position: relative;
	width: 100px;
	height: 100px;
}

.thumbnail-wrapper img {
	width: 100%;
	height: 100%;
	object-fit: cover;
	border-radius: 8px;
}

.thumbnail-wrapper .remove-btn {
	position: absolute;
	top: -4px;
	right: -4px;
}

.existing-thumbnail-wrapper {
	position: relative;
	width: 100%;
	max-width: 300px;
	min-height: 80px;
	display: flex;
	align-items: center;
	justify-content: center;
}

.existing-thumbnail-wrapper img {
	width: 100%;
	height: auto;
	border-radius: 8px;
	object-fit: cover;
}

.preview-spinner {
	position: absolute;
}

.preview-fallback {
	color: var(--ion-color-medium);
	margin: 0;
}
</style>
