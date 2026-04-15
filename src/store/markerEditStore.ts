import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { GeoPoint } from '@/types/geo';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { useOsmAuthStore } from '@/store/osmAuthStore';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { storeMapNodes, deleteMapNode } from '@/mapHandler/databaseHandler';
import { useImageUploadStore } from '@/store/imageUploadStore';
import { toastController, alertController } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import * as OSM from 'osm-api';
import { useRoute, useRouter } from 'vue-router';
import { version } from '@/../package.json';

export const useMarkerEditStore = defineStore('markerEdit', () => {
	const isEditing = ref(false);
	const isAdding = ref(false);
	const pendingLocation = ref<GeoPoint | null>(null);
	const editableTags = ref<Record<string, string>>({});
	const originalMarker = ref<OverPassElement | null>(null);
	const router = useRouter();
	const route = useRoute();

	const osmAuthStore = useOsmAuthStore();
	const markerStore = useMapMarkerStore();
	const { t } = useI18n();

	const isActive = computed(() => isEditing.value || isAdding.value);
	const markerType = computed(() => editableTags.value['emergency'] || 'fire_hydrant');

	watch(isActive, (isActive) => {
		if (isActive) {
			router.push('/');
		}
	});

	watch(route, (to) => {
		if (to.fullPath !== '/') {
			cancelEdit();
		}
	});

	function startEditing(marker: OverPassElement) {
		isEditing.value = true;
		isAdding.value = false;
		originalMarker.value = marker;
		editableTags.value = { ...marker.tags };
		pendingLocation.value = marker.lat && marker.lon ? { lat: marker.lat, lng: marker.lon } : null;
	}

	function startAdding(location: GeoPoint) {
		isAdding.value = true;
		isEditing.value = false;
		originalMarker.value = null;
		editableTags.value = {
			emergency: 'fire_hydrant',
			'fire_hydrant:type': 'pillar'
		};
		pendingLocation.value = location;
	}

	async function showAuthAlert() {
		const alert = await alertController.create({
			header: t('markerEdit.authDialog.title'),
			message: t('markerEdit.authDialog.message'),
			buttons: [
				{
					text: t('markerEdit.buttons.cancel'),
					role: 'cancel'
				},
				{
					text: t('markerEdit.buttons.login'),
					handler: () => {
						osmAuthStore.login();
					}
				}
			]
		});
		await alert.present();
	}

	async function requestStartEditing(marker: OverPassElement) {
		if (!osmAuthStore.isAuthenticated) {
			await showAuthAlert();
			return;
		}
		startEditing(marker);
	}

	async function requestStartAdding(location: GeoPoint) {
		if (!osmAuthStore.isAuthenticated) {
			await showAuthAlert();
			return;
		}
		startAdding(location);
	}

	function cancelEdit() {
		isEditing.value = false;
		isAdding.value = false;
		pendingLocation.value = null;
		editableTags.value = {};
		originalMarker.value = null;
	}

	/**
	 * Compares current editable state (tags + location) against the original marker.
	 * Returns true if anything has changed and an OSM changeset is needed.
	 * Always returns true when adding (new node always needs a changeset).
	 */
	function hasDataChanged(): boolean {
		if (isAdding.value) return true;
		if (!originalMarker.value) return false;

		const original = originalMarker.value;

		// Compare tags: filter out empty values, then deep-compare against original
		const finalTags = Object.fromEntries(
			Object.entries(editableTags.value).filter(([, v]) => v !== '' && v != null)
		);
		const originalTags = original.tags || {};

		const finalKeys = Object.keys(finalTags).sort();
		const originalKeys = Object.keys(originalTags).sort();

		if (finalKeys.length !== originalKeys.length) return true;

		for (const key of finalKeys) {
			if (finalTags[key] !== originalTags[key]) return true;
		}

		for (const key of originalKeys) {
			if (!(key in finalTags)) return true;
		}

		// Compare location with ~1 cm tolerance (1e-7 degrees ≈ 1.1 cm)
		const newLat = pendingLocation.value?.lat || 0;
		const newLon = pendingLocation.value?.lng || 0;
		const origLat = original.lat || 0;
		const origLon = original.lon || 0;

		if (Math.abs(newLat - origLat) > 1e-7 || Math.abs(newLon - origLon) > 1e-7) return true;

		return false;
	}

	async function saveMarker() {
		if (!osmAuthStore.isAuthenticated) {
			return;
		}

		// Filter out empty string values — empty means "remove this tag"
		const finalTags = Object.fromEntries(
			Object.entries(editableTags.value).filter(([, v]) => v !== '' && v != null)
		);
		const lat = pendingLocation.value?.lat || 0;
		const lon = pendingLocation.value?.lng || 0;

		const imageUploadStore = useImageUploadStore();
		const dataChanged = hasDataChanged();

		// If editing and nothing changed, skip the OSM changeset entirely
		if (!dataChanged && isEditing.value) {
			if (imageUploadStore.selectedImages.length > 0) {
				// Only images to upload — use the existing node ID directly
				try {
					await imageUploadStore.uploadAll(originalMarker.value!.id);
					const imgToast = await toastController.create({
						message: t('imageUpload.uploadSuccess'),
						duration: 2000,
						color: 'success'
					});
					await imgToast.present();
					cancelEdit();
				} catch (imgError) {
					console.error('Image upload failed', imgError);
					const imgToast = await toastController.create({
						message: t('imageUpload.uploadError'),
						duration: 3000,
						color: 'warning'
					});
					await imgToast.present();
					// DON'T call cancelEdit() — keep panel open for retry
				}
			} else {
				// Nothing changed at all — inform the user and close
				const toast = await toastController.create({
					message: t('markerEdit.messages.noChanges'),
					duration: 2000,
					color: 'medium'
				});
				await toast.present();
				cancelEdit();
			}
			return;
		}

		try {
			let result: OSM.UploadResult;

			if (isAdding.value) {
				const change: OSM.OsmChange = {
					create: [
						{
							type: 'node',
							id: -1,
							lat,
							lon,
							tags: finalTags
						} as any
					],
					modify: [],
					delete: []
				};
				result = await OSM.uploadChangeset(
					{ comment: `Add ${markerType.value} via FireYak ${version}` },
					change
				);
			} else if (isEditing.value && originalMarker.value) {
				const [node] = await OSM.getFeature('node', originalMarker.value.id);
				node.lat = lat;
				node.lon = lon;
				// Replace tags entirely so cleared fields are removed from OSM
				node.tags = finalTags;

				const change: OSM.OsmChange = {
					create: [],
					modify: [node],
					delete: []
				};
				result = await OSM.uploadChangeset(
					{ comment: `Update ${markerType.value} via FireYak ${version}` },
					change
				);
			} else {
				return;
			}

			if (result) {
				const changesetId = parseInt(Object.keys(result)[0]);
				const diff = result[changesetId].diffResult;
				let finalId = originalMarker.value?.id || 0;

				if (isAdding.value && diff.node) {
					finalId = diff.node[-1].newId;
				}

				// Update local cache
				const updatedMarker: OverPassElement = {
					id: finalId,
					type: 'node',
					lat,
					lon,
					tags: finalTags
				};
				await storeMapNodes([updatedMarker]);
				markerStore.updateSelectedMarker(updatedMarker);

				const toast = await toastController.create({
					message: t('markerEdit.messages.saveSuccess'),
					duration: 2000,
					color: 'success'
				});
				await toast.present();

				// After OSM save succeeds, check for pending image uploads
				if (imageUploadStore.selectedImages.length > 0) {
					try {
						await imageUploadStore.uploadAll(finalId);
						const imgToast = await toastController.create({
							message: t('imageUpload.uploadSuccess'),
							duration: 2000,
							color: 'success'
						});
						await imgToast.present();
					} catch (imgError) {
						console.error('Image upload failed', imgError);
						const imgToast = await toastController.create({
							message: t('imageUpload.uploadError'),
							duration: 3000,
							color: 'warning'
						});
						await imgToast.present();
						// DON'T call cancelEdit() — keep panel open for retry
						return;
					}
				}

				cancelEdit();
			}
		} catch (e) {
			console.error('Failed to save to OSM', e);
			const toast = await toastController.create({
				message: t('markerEdit.messages.saveError'),
				duration: 3000,
				color: 'danger'
			});
			await toast.present();
		}
	}

	async function requestDeleteMarker() {
		if (!osmAuthStore.isAuthenticated || !originalMarker.value) {
			return;
		}

		const alert = await alertController.create({
			header: t('markerEdit.deleteDialog.title'),
			message: t('markerEdit.deleteDialog.message'),
			buttons: [
				{
					text: t('markerEdit.buttons.cancel'),
					role: 'cancel'
				},
				{
					text: t('markerEdit.deleteDialog.confirm'),
					role: 'destructive',
					handler: () => {
						deleteMarker();
					}
				}
			]
		});
		await alert.present();
	}

	async function deleteMarker() {
		if (!osmAuthStore.isAuthenticated || !originalMarker.value) {
			return;
		}

		try {
			const [node] = await OSM.getFeature('node', originalMarker.value.id);
			const change: OSM.OsmChange = {
				create: [],
				modify: [],
				delete: [node]
			};
			await OSM.uploadChangeset(
				{ comment: `Remove ${markerType.value} via FireYak ${version}` },
				change
			);

			await deleteMapNode(originalMarker.value.id);
			markerStore.selectMarker(null);
			cancelEdit();

			const toast = await toastController.create({
				message: t('markerEdit.messages.deleteSuccess'),
				duration: 2000,
				color: 'success'
			});
			await toast.present();
		} catch (e) {
			console.error('Failed to delete from OSM', e);
			const toast = await toastController.create({
				message: t('markerEdit.messages.deleteError'),
				duration: 3000,
				color: 'danger'
			});
			await toast.present();
		}
	}

	function updateTag(key: string, value: string) {
		if (value === '') {
			delete editableTags.value[key];
		} else {
			editableTags.value[key] = value;
		}
	}

	return {
		isEditing,
		isAdding,
		isActive,
		markerType,
		pendingLocation,
		editableTags,
		originalMarker,
		startEditing,
		startAdding,
		requestStartEditing,
		requestStartAdding,
		cancelEdit,
		saveMarker,
		hasDataChanged,
		requestDeleteMarker,
		updateTag
	};
});
