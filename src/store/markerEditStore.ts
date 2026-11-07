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
import { useInAppReview } from '@/composable/inAppReview';
import { enqueueEdit, isNetworkError } from '@/offline/editQueue';
import { toRef } from '@/helper/osmRef';
import {
	describeEdit,
	elementPosition,
	elementTypeOf,
	hasPhysicalWaterTag,
	isAreaType,
	isMarkerTags,
	toCacheElement,
	withoutFirePondFlag
} from '@/helper/osmElement';

/** How long the "saved" toast stays up after a successful upload. */
const SAVE_SUCCESS_TOAST_MS = 2000;

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
	const { scheduleAutoPrompt } = useInAppReview();
	const { isOnline } = useNetworkStatus();
	const { t } = useI18n();

	/**
	 * Physical tags (`natural`, `water`) that the form added itself when the
	 * type was switched to fire water pond. Only these may be removed again on
	 * a type switch — tags that were already on the object never are.
	 */
	const autoAddedTags = ref<string[]>([]);

	const isActive = computed(() => isEditing.value || isAdding.value);
	const markerType = computed(() => editableTags.value['emergency'] || 'fire_hydrant');
	/** OSM type of the element being edited; new markers are always nodes. */
	const elementType = computed(() =>
		isEditing.value ? elementTypeOf(originalMarker.value) : 'node'
	);
	/**
	 * True while editing a way/relation (a pond mapped on its water area). Only
	 * its tags can change: no moving, no type switch, no delete.
	 */
	const isArea = computed(() => isAreaType(elementType.value));

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
		autoAddedTags.value = [];
		// Areas show their center for orientation only; it is never uploaded.
		const position = elementPosition(marker);
		pendingLocation.value = position ? { lat: position.lat, lng: position.lon } : null;
	}

	function startAdding(location: GeoPoint) {
		isAdding.value = true;
		isEditing.value = false;
		originalMarker.value = null;
		editableTags.value = {
			emergency: 'fire_hydrant',
			'fire_hydrant:type': 'pillar'
		};
		autoAddedTags.value = [];
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
		autoAddedTags.value = [];
	}

	/**
	 * Sets a physical tag on behalf of the user (only if it is missing) and
	 * remembers it, so {@link removeAutoAddedTags} can undo exactly that.
	 */
	function addTagIfMissing(key: string, value: string) {
		if (editableTags.value[key]) return;
		editableTags.value[key] = value;
		if (!autoAddedTags.value.includes(key)) autoAddedTags.value.push(key);
	}

	/** Removes the tags {@link addTagIfMissing} added during this edit session. */
	function removeAutoAddedTags() {
		for (const key of autoAddedTags.value) delete editableTags.value[key];
		autoAddedTags.value = [];
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
			const type = elementType.value;
			await enqueueEdit({
				action: 'update',
				elementType: type,
				osmId: originalMarker.value.id,
				baseTags: originalMarker.value.tags ?? null,
				tags: finalTags,
				lat,
				lon
			});
			if (isMarkerTags(finalTags)) {
				markerStore.updateSelectedMarker(
					toCacheElement(type, originalMarker.value.id, lat, lon, finalTags)
				);
			} else {
				// Unflagged pond area: it is no longer a marker.
				markerStore.selectMarker(null);
			}
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

		// The OSM wiki requires `emergency=fire_water_pond` to sit on a physical
		// water feature (`natural=water` or similar) — never save a bare flag.
		if (finalTags['emergency'] === 'fire_water_pond' && !hasPhysicalWaterTag(finalTags)) {
			const toast = await toastController.create({
				message: t('markerEdit.messages.pondNeedsWater'),
				duration: 3000,
				color: 'warning'
			});
			await toast.present();
			return;
		}

		await commitTags(finalTags, t('markerEdit.messages.saveSuccess'));
	}

	/**
	 * Uploads `finalTags` for the current add/edit (or queues them offline) and
	 * updates the local cache. For areas only the tags change: the element is
	 * re-fetched from OSM and uploaded with its own nodes/members untouched.
	 */
	async function commitTags(finalTags: Record<string, string>, successMessage: string) {
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
				const [element] = await OSM.getFeature(elementType.value, originalMarker.value.id);
				// Only nodes move. Ways/relations keep their geometry untouched.
				if (element.type === 'node') {
					element.lat = lat;
					element.lon = lon;
				}
				// Replace tags entirely so cleared fields are removed from OSM
				element.tags = finalTags;

				const change: OSM.OsmChange = {
					create: [],
					modify: [element],
					delete: []
				};
				const description = describeEdit(
					'update',
					elementType.value,
					originalMarker.value.tags,
					finalTags
				);
				result = await OSM.uploadChangeset(
					{ comment: `${description} via FireYak ${version}` },
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
				const type = isAdding.value ? 'node' : elementType.value;
				if (isMarkerTags(finalTags)) {
					const updatedMarker: OverPassElement = toCacheElement(type, finalId, lat, lon, finalTags);
					await storeMapNodes([updatedMarker]);
					markerStore.updateSelectedMarker(updatedMarker);
				} else {
					// An unflagged pond area is no longer a marker; tombstone it so the
					// static extract (days behind OSM) cannot bring it back.
					await deleteMapNode(toRef(type, finalId));
					markerStore.selectMarker(null);
				}
				markerCacheVersion.value++;

				const toast = await toastController.create({
					message: successMessage,
					duration: SAVE_SUCCESS_TOAST_MS,
					color: 'success'
				});
				await toast.present();
				cancelEdit();

				// A contribution that reached OSM is the best moment to ask for a
				// rating — after the toast, so the dialog doesn't cover it.
				scheduleAutoPrompt(SAVE_SUCCESS_TOAST_MS);
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

		// Areas are never deleted — that would remove the water body itself.
		// "Delete" on a pond area removes only the fire-pond information.
		if (isArea.value) {
			await requestUnflag();
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

	async function requestUnflag() {
		const alert = await alertController.create({
			header: t('markerEdit.unflagDialog.title'),
			message: t('markerEdit.unflagDialog.message'),
			buttons: [
				{
					text: t('markerEdit.buttons.cancel'),
					role: 'cancel'
				},
				{
					text: t('markerEdit.unflagDialog.confirm'),
					role: 'destructive',
					handler: () => {
						unflagMarker();
					}
				}
			]
		});
		await alert.present();
	}

	/**
	 * Removes `emergency=fire_water_pond` (and pond-only sub-tags) from the
	 * edited area, starting from its server tags — unsaved form changes are
	 * dropped. The water body and its physical tags stay in OSM.
	 */
	async function unflagMarker() {
		if (!osmAuthStore.isAuthenticated || !originalMarker.value || !isArea.value) {
			return;
		}
		const tags = withoutFirePondFlag(originalMarker.value.tags ?? {});
		editableTags.value = { ...tags };
		await commitTags(tags, t('markerEdit.messages.unflagSuccess'));
	}

	async function deleteMarker() {
		if (!osmAuthStore.isAuthenticated || !originalMarker.value || isArea.value) {
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

			await deleteMapNode(toRef('node', originalMarker.value.id));
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
		elementType,
		isArea,
		addTagIfMissing,
		removeAutoAddedTags,
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
