import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { LatLng } from 'leaflet';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { useOsmAuthStore } from '@/store/osmAuthStore';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { storeMapNodes, deleteMapNode } from '@/mapHandler/databaseHandler';
import { toastController, alertController } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import * as OSM from 'osm-api';
import { useRoute, useRouter } from 'vue-router';
import { version } from '@/../package.json';

export const useMarkerEditStore = defineStore('markerEdit', () => {
	const isEditing = ref(false);
	const isAdding = ref(false);
	const pendingLocation = ref<LatLng | null>(null);
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
		pendingLocation.value = marker.lat && marker.lon ? new LatLng(marker.lat, marker.lon) : null;
	}

	function startAdding(location: LatLng) {
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

	async function requestStartAdding(location: LatLng) {
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

	async function saveMarker() {
		if (!osmAuthStore.isAuthenticated) {
			return;
		}

		try {
			// Filter out empty string values — empty means "remove this tag"
			const finalTags = Object.fromEntries(
				Object.entries(editableTags.value).filter(([, v]) => v !== '' && v != null)
			);
			const lat = pendingLocation.value?.lat || 0;
			const lon = pendingLocation.value?.lng || 0;
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
		requestDeleteMarker,
		updateTag
	};
});
