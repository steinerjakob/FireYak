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
	alertController,
	toastController
} from '@ionic/vue';
import { cameraOutline, closeCircle, openOutline } from 'ionicons/icons';
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useImageUploadStore } from '@/store/imageUploadStore';
import { useWikimediaAuthStore } from '@/store/wikimediaAuthStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useSettings } from '@/composable/settings';
import { useMarkerEditStore } from '@/store/markerEditStore';

const imageUploadStore = useImageUploadStore();
const wikimediaAuthStore = useWikimediaAuthStore();
const settingsStore = useSettingsStore();
const markerEditStore = useMarkerEditStore();
const { saveWikimediaLicenseAccepted, getWikimediaLicenseAccepted } = useSettings();
const { t } = useI18n();

// Load existing images when editing an existing marker
watch(
	() => markerEditStore.originalMarker,
	(marker) => {
		if (marker) {
			imageUploadStore.loadExistingImages(marker.id);
		}
	},
	{ immediate: true }
);

// Reset image upload store when editing is deactivated
watch(
	() => markerEditStore.isActive,
	(active) => {
		if (!active) {
			imageUploadStore.reset();
		}
	}
);

const showAuthAlert = async () => {
	const alert = await alertController.create({
		header: t('wikimediaAuth.authDialog.title'),
		message: t('wikimediaAuth.authDialog.message'),
		buttons: [
			{
				text: t('imageUpload.license.decline'),
				role: 'cancel'
			},
			{
				text: t('wikimediaAuth.buttons.login'),
				handler: () => {
					wikimediaAuthStore.login();
				}
			}
		]
	});
	await alert.present();
};

const showLicenseDialog = async (): Promise<boolean> => {
	return new Promise((resolve) => {
		alertController
			.create({
				header: t('imageUpload.license.title'),
				message: t('imageUpload.license.message'),
				buttons: [
					{
						text: t('imageUpload.license.decline'),
						role: 'cancel',
						handler: () => resolve(false)
					},
					{
						text: t('imageUpload.license.agree'),
						handler: () => {
							saveWikimediaLicenseAccepted(true);
							resolve(true);
						}
					}
				]
			})
			.then((alert) => alert.present());
	});
};

const handleAddImage = async () => {
	// Check authentication
	if (!wikimediaAuthStore.isAuthenticated) {
		await showAuthAlert();
		return;
	}

	// Check license acceptance
	let licenseAccepted = settingsStore.wikimediaLicenseAccepted;
	if (!licenseAccepted) {
		licenseAccepted = await getWikimediaLicenseAccepted();
	}
	if (!licenseAccepted) {
		const accepted = await showLicenseDialog();
		if (!accepted) return;
	}

	// Select image
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

const openCommonsUrl = (url: string) => {
	window.open(url, '_blank');
};

const retryUpload = async () => {
	// Retry will be handled in the save flow of markerEditStore
	// For now, just clear the error so user can try saving again
	imageUploadStore.uploadError = null;
};
</script>

<template>
	<ion-item-group>
		<ion-item-divider>
			<ion-label>
				📷 {{ t('imageUpload.title') }} ({{
					t('imageUpload.count', {
						count: imageUploadStore.totalImages,
						max: imageUploadStore.MAX_IMAGES_PER_MARKER
					})
				}})
			</ion-label>
		</ion-item-divider>

		<!-- New images to upload -->
		<ion-item v-if="imageUploadStore.selectedImages.length > 0" lines="none">
			<ion-label>{{ t('imageUpload.newImages') }}</ion-label>
		</ion-item>
		<div
			v-if="imageUploadStore.selectedImages.length > 0 || imageUploadStore.canAddMore"
			class="image-thumbnails"
		>
			<div
				v-for="(image, index) in imageUploadStore.selectedImages"
				:key="'new-' + index"
				class="thumbnail-wrapper"
			>
				<img :src="image.webPath" :alt="image.name" />
				<ion-button
					class="remove-btn"
					fill="clear"
					size="small"
					color="danger"
					@click="imageUploadStore.removeSelectedImage(index)"
				>
					<ion-icon slot="icon-only" :icon="closeCircle"></ion-icon>
				</ion-button>
			</div>

			<!-- Add button -->
			<div v-if="imageUploadStore.canAddMore" class="thumbnail-wrapper add-button">
				<ion-button fill="clear" @click="handleAddImage()">
					<ion-icon slot="icon-only" :icon="cameraOutline"></ion-icon>
				</ion-button>
			</div>
		</div>

		<!-- Max reached message -->
		<ion-item v-if="!imageUploadStore.canAddMore" lines="none">
			<ion-note color="medium">{{
				t('imageUpload.maxReached', { max: imageUploadStore.MAX_IMAGES_PER_MARKER })
			}}</ion-note>
		</ion-item>

		<!-- Existing Commons images -->
		<ion-item v-if="imageUploadStore.existingImages.length > 0" lines="none">
			<ion-label>{{ t('imageUpload.existingImages') }}</ion-label>
		</ion-item>
		<div v-if="imageUploadStore.existingImages.length > 0" class="image-thumbnails">
			<div
				v-for="image in imageUploadStore.existingImages"
				:key="'existing-' + image.pageid"
				class="thumbnail-wrapper"
			>
				<img
					:src="image.imageinfo[0]?.thumburl"
					:alt="image.title"
					@click="openCommonsUrl(image.imageinfo[0]?.descriptionurl)"
				/>
				<ion-button
					class="open-btn"
					fill="clear"
					size="small"
					@click="openCommonsUrl(image.imageinfo[0]?.descriptionurl)"
				>
					<ion-icon slot="icon-only" :icon="openOutline"></ion-icon>
				</ion-button>
			</div>
		</div>

		<!-- Upload progress -->
		<ion-item v-if="imageUploadStore.isUploading" lines="none">
			<ion-label>
				{{
					t('imageUpload.uploading', {
						current: imageUploadStore.currentUploadIndex + 1,
						total: imageUploadStore.selectedImages.length
					})
				}}
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
.image-thumbnails {
	display: flex;
	overflow-x: auto;
	gap: 8px;
	padding: 8px 16px;
}

.thumbnail-wrapper {
	position: relative;
	flex-shrink: 0;
	width: 80px;
	height: 80px;
}

.thumbnail-wrapper img {
	width: 100%;
	height: 100%;
	object-fit: cover;
	border-radius: 8px;
	cursor: pointer;
}

.thumbnail-wrapper .remove-btn {
	position: absolute;
	top: -4px;
	right: -4px;
}

.thumbnail-wrapper .open-btn {
	position: absolute;
	bottom: -4px;
	right: -4px;
}

.thumbnail-wrapper.add-button {
	display: flex;
	align-items: center;
	justify-content: center;
	border: 2px dashed var(--ion-color-medium);
	border-radius: 8px;
}
</style>
