import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { GeoPoint, distanceTo } from '@/types/geo';
import { OverPassElement, type WaterAreaCandidate } from '@/mapHandler/overPassApi';
import { fetchWaterAreasAt } from '@/mapHandler/waterAreaLookup';
import type { WaterDetection } from '@/mapHandler/waterDetection';
import { debounce } from '@/helper/helper';
import { useOsmAuthStore } from '@/store/osmAuthStore';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { usePendingEditsStore } from '@/store/pendingEditsStore';
import {
	storeMapNodes,
	deleteMapNode,
	clearDeletedMapNode,
	getNearbyMapNodes
} from '@/mapHandler/databaseHandler';
import { rememberOutline } from '@/mapHandler/areaOutline';
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
	mergeTagEdit,
	toCacheElement,
	withoutFirePondFlag
} from '@/helper/osmElement';
import { getFeatureForEdit, rememberDevServerCreate, uploadChange } from '@/services/osmWrite';

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
	/**
	 * True while marking an existing water area as a fire pond (entered only
	 * through {@link startFlagging}): the area is not a pond on the server yet,
	 * so there is nothing to remove. Tracked explicitly — editing some other
	 * area (e.g. a water tank mapped as a way) is not flagging.
	 */
	const flagging = ref(false);
	const isFlagging = computed(() => isEditing.value && flagging.value);
	/** True while editing an area that already is a fire pond on the server. */
	const isPondArea = computed(
		() => isArea.value && originalMarker.value?.tags?.['emergency'] === 'fire_water_pond'
	);
	/**
	 * Whether the edit sheet offers a delete action: nodes are deleted, pond
	 * areas are unflagged, any other area (and a flag in progress) has none.
	 */
	const canDelete = computed(
		() => isEditing.value && !isFlagging.value && (!isArea.value || isPondArea.value)
	);

	// --- Water areas at the pin (flagging an existing pond, plan §2.1/§2.5) ---

	/**
	 * Protomaps "is there water under the pin?" result. Written by `MainMap`,
	 * which owns the map instance, whenever the pin moves in add mode.
	 */
	const detectedWater = ref<WaterDetection | null>(null);
	/** OSM water areas at/next to the pin, from the Overpass lookup. */
	const areaCandidates = ref<WaterAreaCandidate[]>([]);
	/**
	 * `skipped`: Protomaps sees no water here, so Overpass was not asked.
	 * `offline`: no network — existing areas cannot be looked up.
	 */
	const areaLookupState = ref<'idle' | 'loading' | 'done' | 'failed' | 'offline' | 'skipped'>(
		'idle'
	);
	let areaLookupController: AbortController | null = null;
	/**
	 * Fire water ponds already on the map near the pin, from the local marker
	 * cache — the duplicate guard for pond **nodes** (Overpass only returns
	 * areas). Works offline, as far as the cache reaches.
	 */
	const nearbyPonds = ref<{ element: OverPassElement; distanceM: number }[]>([]);
	/** Radius (m) in which an existing pond counts as "probably the same one". */
	const DUPLICATE_POND_RADIUS_M = 60;
	/** Debounce for the Overpass lookup — pin drags must not burn rate limit. */
	const AREA_LOOKUP_DEBOUNCE_MS = 700;

	const wantsAreaLookup = computed(
		() => isAdding.value && markerType.value === 'fire_water_pond' && pendingLocation.value != null
	);

	function resetAreaLookup() {
		areaLookupController?.abort();
		areaLookupController = null;
		areaCandidates.value = [];
		nearbyPonds.value = [];
		areaLookupState.value = 'idle';
	}

	async function findNearbyPonds(location: GeoPoint) {
		const nodes = await getNearbyMapNodes(location, DUPLICATE_POND_RADIUS_M);
		if (pendingLocation.value !== location) return; // pin moved meanwhile
		nearbyPonds.value = nodes
			.filter((n) => n.tags?.['emergency'] === 'fire_water_pond' && n.id > 0)
			.map((element) => {
				const position = elementPosition(element);
				const distanceM = position
					? distanceTo(location, { lat: position.lat, lng: position.lon })
					: 0;
				return { element, distanceM };
			})
			.sort((a, b) => a.distanceM - b.distanceM);
	}

	const runAreaLookup = debounce(async () => {
		const location = pendingLocation.value;
		if (!wantsAreaLookup.value || !location) return;
		void findNearbyPonds(location);
		if (!isOnline.value) {
			areaCandidates.value = [];
			areaLookupState.value = 'offline';
			return;
		}
		// No skip on "no water in the tiles": the lookup only runs once the user
		// chose the pond type, and the tiles can miss small or new ponds. The
		// Protomaps check only drives the suggestion chip and hints (plan §B2).

		areaLookupController?.abort();
		const controller = new AbortController();
		areaLookupController = controller;
		areaLookupState.value = 'loading';

		const result = await fetchWaterAreasAt(location.lat, location.lng, controller.signal);
		if (controller.signal.aborted || areaLookupController !== controller) return;
		areaLookupController = null;
		for (const c of result ?? []) rememberOutline(toRef(c.element.type, c.element.id), c.outline);
		areaCandidates.value = result ?? [];
		areaLookupState.value = result ? 'done' : 'failed';
	}, AREA_LOOKUP_DEBOUNCE_MS);

	watch([wantsAreaLookup, pendingLocation, isOnline], () => {
		if (!wantsAreaLookup.value) {
			resetAreaLookup();
			return;
		}
		// Drop a lookup still running for the previous pin, so its result can
		// never be shown (and flagged) for the new position.
		areaLookupController?.abort();
		areaLookupController = null;
		areaCandidates.value = [];
		areaLookupState.value = 'loading';
		runAreaLookup();
	});

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
		flagging.value = false;
		originalMarker.value = marker;
		editableTags.value = { ...marker.tags };
		autoAddedTags.value = [];
		// Older pond nodes often carry only the flag. The wiki requires the
		// physical water feature too, so a node edit adds `natural=water`.
		// Areas are left alone: their physical tagging is not ours to change.
		if (
			marker.tags?.['emergency'] === 'fire_water_pond' &&
			!isAreaType(marker.type) &&
			!hasPhysicalWaterTag(marker.tags)
		) {
			addTagIfMissing('natural', 'water');
		}
		// Areas show their center for orientation only; it is never uploaded.
		const position = elementPosition(marker);
		pendingLocation.value = position ? { lat: position.lat, lng: position.lon } : null;
	}

	function startAdding(location: GeoPoint) {
		isAdding.value = true;
		isEditing.value = false;
		flagging.value = false;
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

	// Preview builds may edit existing (production) objects: saving them is a
	// dry run that shows the changeset instead of uploading it — see
	// `src/services/osmWrite.ts`.
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

	/**
	 * Switches from "add a pond node" to "mark this existing water area as a
	 * fire water pond". The area's real server tags become the edit's base
	 * (conflict snapshot) and only `emergency=fire_water_pond` is added; the
	 * user can then fill in the remaining fields and save as a tag-only edit.
	 */
	async function startFlagging(candidate: WaterAreaCandidate) {
		const element = candidate.element;
		resetAreaLookup();
		startEditing(element);
		flagging.value = true;
		editableTags.value = { ...element.tags, emergency: 'fire_water_pond' };
	}

	/**
	 * Opens the add form for the pond's pumping spot (plan flow E): a suction
	 * point at `location`, prefilled with `water_source=pond`. The user then
	 * drags the pin to where the engine actually parks and pumps.
	 */
	async function requestAddSuctionPoint(location: GeoPoint) {
		if (!osmAuthStore.isAuthenticated) {
			await showAuthAlert();
			return;
		}
		startAdding(location);
		editableTags.value = { emergency: 'suction_point', water_source: 'pond' };
	}

	/** After a pond is saved, offer to add its pumping spot right away. */
	async function offerSuctionPoint(location: GeoPoint) {
		const toast = await toastController.create({
			message: t('markerEdit.suctionOffer.message'),
			duration: 6000,
			buttons: [
				{
					text: t('markerEdit.suctionOffer.action'),
					handler: () => {
						void requestAddSuctionPoint(location);
					}
				}
			]
		});
		await toast.present();
	}

	function cancelEdit() {
		resetAreaLookup();
		detectedWater.value = null;
		flagging.value = false;
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
				outline: originalMarker.value.outline,
				osmId: originalMarker.value.id,
				baseTags: originalMarker.value.tags ?? null,
				tags: finalTags,
				lat,
				lon
			});
			if (isMarkerTags(finalTags)) {
				markerStore.updateSelectedMarker(
					toCacheElement(
						type,
						originalMarker.value.id,
						lat,
						lon,
						finalTags,
						originalMarker.value.outline
					)
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
		// water feature (`natural=water` or similar) — never save a bare pond
		// node. Existing areas are not blocked: FireYak does not change their
		// physical tagging, and some valid-looking ponds carry only `water=pond`.
		if (
			!isArea.value &&
			finalTags['emergency'] === 'fire_water_pond' &&
			!hasPhysicalWaterTag(finalTags)
		) {
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
	/**
	 * After a conflict: make the server's current tags the new edit base and
	 * show the other mapper's values in the conflicting fields, keeping the
	 * user's other changes. A second save then merges cleanly.
	 */
	function rebaseOnServer(serverTags: Record<string, string>, conflicts: string[]) {
		if (!originalMarker.value) return;
		originalMarker.value = { ...originalMarker.value, tags: { ...serverTags } };
		for (const key of conflicts) {
			if (serverTags[key] === undefined) delete editableTags.value[key];
			else editableTags.value[key] = serverTags[key];
		}
	}

	/** Another mapper changed the same keys since the edit started — don't upload. */
	async function showConflictAlert(keys: string[]) {
		const alert = await alertController.create({
			header: t('markerEdit.conflictDialog.title'),
			message: t('markerEdit.conflictDialog.message', { keys: keys.join(', ') }),
			buttons: [t('markerEdit.conflictDialog.ok')]
		});
		await alert.present();
	}

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
				result = await uploadChange(
					{ comment: `Add ${markerType.value} via FireYak ${version}` },
					change,
					{ interactive: true }
				);
			} else if (isEditing.value && originalMarker.value) {
				const element = await getFeatureForEdit(elementType.value, originalMarker.value.id);
				// Apply only what the user changed on top of the element's current
				// tags, so a concurrent edit by another mapper is not overwritten.
				const merged = mergeTagEdit(originalMarker.value.tags ?? {}, finalTags, element.tags ?? {});
				if ('conflicts' in merged) {
					rebaseOnServer(element.tags ?? {}, merged.conflicts);
					await showConflictAlert(merged.conflicts);
					return;
				}
				finalTags = merged.tags;
				// Only nodes move. Ways/relations keep their geometry untouched.
				if (element.type === 'node') {
					element.lat = lat;
					element.lon = lon;
				}
				// The merged tag set: cleared fields are removed from OSM too.
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
				result = await uploadChange({ comment: `${description} via FireYak ${version}` }, change, {
					interactive: true
				});
			} else {
				return;
			}

			if (result) {
				const changesetId = parseInt(Object.keys(result)[0]);
				const diff = result[changesetId].diffResult;
				let finalId = originalMarker.value?.id || 0;

				if (isAdding.value && diff.node) {
					finalId = diff.node[-1].newId;
					rememberDevServerCreate('node', finalId);
				}

				// Update local cache
				const type = isAdding.value ? 'node' : elementType.value;
				if (isMarkerTags(finalTags)) {
					// A freshly flagged area may carry a tombstone from an earlier
					// local unflag — lift it so the stored marker is visible.
					if (isAreaType(type)) await clearDeletedMapNode(toRef(type, finalId));
					const updatedMarker: OverPassElement = toCacheElement(
						type,
						finalId,
						lat,
						lon,
						finalTags,
						originalMarker.value?.outline
					);
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
				// A newly added or newly marked pond rarely has its pumping spot
				// mapped yet — offer it once the "saved" toast is gone.
				const offerPumpingSpot =
					finalTags['emergency'] === 'fire_water_pond' && (isAdding.value || isFlagging.value);
				cancelEdit();
				if (offerPumpingSpot) {
					setTimeout(() => void offerSuctionPoint({ lat, lng: lon }), SAVE_SUCCESS_TOAST_MS);
				}

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
		// "Delete" on a pond area removes only the fire-pond information; other
		// areas (e.g. a tank mapped as a way) have no delete action at all.
		if (isArea.value) {
			if (isPondArea.value) await requestUnflag();
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
		if (!osmAuthStore.isAuthenticated || !originalMarker.value || !isPondArea.value) {
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
			const node = await getFeatureForEdit('node', originalMarker.value.id);
			const change: OSM.OsmChange = {
				create: [],
				modify: [],
				delete: [node]
			};
			await uploadChange({ comment: `Remove ${markerType.value} via FireYak ${version}` }, change, {
				interactive: true
			});

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
		isFlagging,
		isPondArea,
		canDelete,
		nearbyPonds,
		requestAddSuctionPoint,
		detectedWater,
		areaCandidates,
		areaLookupState,
		startFlagging,
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
