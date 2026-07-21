import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { GeoPoint } from '@/types/geo';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { useOsmAuthStore } from '@/store/osmAuthStore';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { usePendingEditsStore } from '@/store/pendingEditsStore';
import { storeMapNodes, deleteMapNode } from '@/mapHandler/databaseHandler';
import { markerCacheVersion } from '@/mapHandler/markerHandler';
import { toastController, alertController } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import * as OSM from 'osm-api';
import { useRoute, useRouter } from 'vue-router';
import { version } from '@/../package.json';
import { useNetworkStatus } from '@/composable/networkStatus';
import { enqueueEdit, isNetworkError } from '@/offline/editQueue';

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
	const pendingEditsStore = usePendingEditsStore();
	const { isOnline } = useNetworkStatus();
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

	/** Toast shown when an edit is queued for later sync instead of uploaded. */
	async function showQueuedToast() {
		const toast = await toastController.create({
			message: t('pendingEdits.messages.queued'),
			duration: 2500,
			color: 'warning'
		});
		await toast.present();
	}

	/**
	 * Persists the current save/delete into the offline queue instead of uploading
	 * it. Used when we're offline, when an online upload fails with a network
	 * error, or when the edited node is itself a not-yet-synced offline create
	 * (negative id) — the latter must never hit the OSM API, so `enqueueEdit`
	 * coalesces it into the queue.
	 */
	async function enqueueCurrentEdit(finalTags: Record<string, string>, lat: number, lon: number) {
		if (isAdding.value) {
			await enqueueEdit({ action: 'create', osmId: 0, baseTags: null, tags: finalTags, lat, lon });
		} else if (isEditing.value && originalMarker.value) {
			await enqueueEdit({
				action: 'update',
				osmId: originalMarker.value.id,
				baseTags: originalMarker.value.tags ?? null,
				tags: finalTags,
				lat,
				lon
			});
			markerStore.updateSelectedMarker({
				id: originalMarker.value.id,
				type: 'node',
				lat,
				lon,
				tags: finalTags
			});
		} else {
			return;
		}
		await pendingEditsStore.refresh();
		await showQueuedToast();
		cancelEdit();
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

		// Offline, or editing a node that is still a pending offline create
		// (negative id) — queue it; the online path would fail / hit OSM with a
		// temp id.
		const isTempNode = (originalMarker.value?.id ?? 0) < 0;
		if (!isOnline.value || isTempNode) {
			await enqueueCurrentEdit(finalTags, lat, lon);
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
				markerCacheVersion.value++;
				markerStore.updateSelectedMarker(updatedMarker);

				const toast = await toastController.create({
					message: t('markerEdit.messages.saveSuccess'),
					duration: 2000,
					color: 'success'
				});
				await toast.present();
				cancelEdit();
			}
		} catch (e) {
			// A network failure mid-upload → fall back to the offline queue rather
			// than telling the user the save failed.
			if (isNetworkError(e)) {
				await enqueueCurrentEdit(finalTags, lat, lon);
				return;
			}
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

	/** Queues a delete for later sync (offline, temp node, or network fallback). */
	async function enqueueDelete() {
		if (!originalMarker.value) return;
		const marker = originalMarker.value;
		await enqueueEdit({
			action: 'delete',
			osmId: marker.id,
			baseTags: marker.tags ?? null,
			tags: marker.tags ?? {},
			lat: marker.lat ?? 0,
			lon: marker.lon ?? 0
		});
		await pendingEditsStore.refresh();
		markerStore.selectMarker(null);
		cancelEdit();
		await showQueuedToast();
	}

	async function deleteMarker() {
		if (!osmAuthStore.isAuthenticated || !originalMarker.value) {
			return;
		}

		// Offline, or the node is still a pending offline create (negative id) —
		// queue it; enqueueEdit drops the create instead of calling OSM.
		const isTempNode = originalMarker.value.id < 0;
		if (!isOnline.value || isTempNode) {
			await enqueueDelete();
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
			markerCacheVersion.value++;
			markerStore.selectMarker(null);
			cancelEdit();

			const toast = await toastController.create({
				message: t('markerEdit.messages.deleteSuccess'),
				duration: 2000,
				color: 'success'
			});
			await toast.present();
		} catch (e) {
			// Network failure mid-upload → fall back to the offline queue.
			if (isNetworkError(e)) {
				await enqueueDelete();
				return;
			}
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
		requestDeleteMarker,
		updateTag
	};
});
