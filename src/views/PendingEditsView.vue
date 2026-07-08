<template>
	<ion-page>
		<ion-header :translucent="true">
			<ion-toolbar>
				<ion-buttons slot="start">
					<ion-back-button default-href="/settings"></ion-back-button>
				</ion-buttons>
				<ion-title>{{ $t('pendingEdits.title') }}</ion-title>
				<ion-buttons slot="end">
					<ion-button :disabled="!isOnline || !edits.length" @click="syncNow()">
						<ion-icon slot="icon-only" :icon="cloudUploadOutline"></ion-icon>
					</ion-button>
				</ion-buttons>
			</ion-toolbar>
		</ion-header>

		<ion-content :fullscreen="true">
			<!-- Offline hint: syncing needs a connection -->
			<div v-if="!isOnline && edits.length" class="offline-hint">
				<ion-icon :icon="cloudOfflineOutline"></ion-icon>
				<span>{{ $t('pendingEdits.offlineHint') }}</span>
			</div>

			<!-- Empty state -->
			<div v-if="!edits.length" class="empty-state">
				<ion-icon :icon="checkmarkDoneOutline" class="empty-icon"></ion-icon>
				<h2>{{ $t('pendingEdits.empty.title') }}</h2>
				<p>{{ $t('pendingEdits.empty.description') }}</p>
			</div>

			<ion-list v-else>
				<template v-for="edit in edits" :key="edit.localId">
					<ion-item lines="full">
						<img slot="start" :src="iconFor(edit)" class="type-icon" alt="" />
						<ion-label>
							<h2>{{ titleFor(edit) }}</h2>
							<p>{{ actionLabel(edit) }} · {{ tagSummary(edit) }}</p>
							<p v-if="edit.status === 'error' && edit.errorMessage" class="error-line">
								{{ edit.errorMessage }}
							</p>
						</ion-label>
						<ion-chip slot="end" :color="statusColor(edit.status)" class="status-chip">
							{{ $t(`pendingEdits.status.${edit.status}`) }}
						</ion-chip>
					</ion-item>

					<!-- Error actions -->
					<ion-item
						v-if="edit.status === 'error'"
						:key="`err-${edit.localId}`"
						lines="full"
						class="actions-row"
					>
						<ion-button
							slot="start"
							size="small"
							fill="clear"
							:disabled="!isOnline"
							@click="store.retry(edit.localId as number)"
						>
							<ion-icon slot="start" :icon="refreshOutline"></ion-icon>
							{{ $t('pendingEdits.actions.retry') }}
						</ion-button>
						<ion-button
							slot="end"
							size="small"
							fill="clear"
							color="danger"
							@click="confirmDiscard(edit)"
						>
							<ion-icon slot="start" :icon="trashOutline"></ion-icon>
							{{ $t('pendingEdits.actions.discard') }}
						</ion-button>
					</ion-item>

					<!-- Conflict: comparison + resolution -->
					<div v-if="edit.status === 'conflict'" :key="`conf-${edit.localId}`" class="conflict-box">
						<div class="conflict-cols">
							<div class="conflict-col">
								<h4>{{ $t('pendingEdits.conflict.mine') }}</h4>
								<ul>
									<li v-for="(v, k) in edit.tags" :key="k">
										<span class="tag-key">{{ k }}</span
										>: {{ v }}
									</li>
								</ul>
							</div>
							<div class="conflict-col">
								<h4>{{ $t('pendingEdits.conflict.server') }}</h4>
								<p v-if="serverTagsLoading[edit.localId as number]" class="muted">
									{{ $t('pendingEdits.conflict.loading') }}
								</p>
								<p v-else-if="serverTags[edit.localId as number] === null" class="muted">
									{{ $t('pendingEdits.conflict.serverMissing') }}
								</p>
								<ul v-else>
									<li v-for="(v, k) in serverTags[edit.localId as number] || {}" :key="k">
										<span class="tag-key">{{ k }}</span
										>: {{ v }}
									</li>
								</ul>
							</div>
						</div>
						<div class="conflict-actions">
							<ion-button
								size="small"
								:disabled="!isOnline"
								@click="store.applyMine(edit.localId as number)"
							>
								{{ $t('pendingEdits.conflict.applyMine') }}
							</ion-button>
							<ion-button size="small" fill="outline" color="danger" @click="confirmDiscard(edit)">
								{{ $t('pendingEdits.conflict.discard') }}
							</ion-button>
						</div>
					</div>
				</template>
			</ion-list>

			<div v-if="edits.length" class="sync-footer">
				<ion-button expand="block" :disabled="!isOnline" @click="syncNow()">
					<ion-icon slot="start" :icon="cloudUploadOutline"></ion-icon>
					{{ $t('pendingEdits.actions.syncNow') }}
				</ion-button>
			</div>
		</ion-content>
	</ion-page>
</template>

<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue';
import {
	IonPage,
	IonHeader,
	IonToolbar,
	IonButtons,
	IonBackButton,
	IonButton,
	IonTitle,
	IonContent,
	IonList,
	IonItem,
	IonLabel,
	IonIcon,
	IonChip,
	alertController,
	toastController
} from '@ionic/vue';
import {
	cloudUploadOutline,
	cloudOfflineOutline,
	checkmarkDoneOutline,
	refreshOutline,
	trashOutline
} from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useNetworkStatus } from '@/composable/networkStatus';
import { usePendingEditsStore } from '@/store/pendingEditsStore';
import { fetchServerTags } from '@/offline/editQueue';
import { getIconUrlForNode } from '@/mapHandler/markerHandler';
import type { PendingEdit } from '@/mapHandler/databaseHandler';

const { t } = useI18n();
const { isOnline } = useNetworkStatus();
const store = usePendingEditsStore();
const { edits } = storeToRefs(store);

/** Server-tag snapshots per conflict entry (null = node gone on the server). */
const serverTags = reactive<Record<number, Record<string, string> | null>>({});
const serverTagsLoading = reactive<Record<number, boolean>>({});

onMounted(() => {
	store.refresh();
});

// Lazily fetch the server tags for any conflict entries so the comparison view
// can show them. Re-runs whenever the list changes.
watch(
	edits,
	(list) => {
		for (const edit of list) {
			if (
				edit.status === 'conflict' &&
				edit.localId != null &&
				!(edit.localId in serverTags) &&
				!serverTagsLoading[edit.localId]
			) {
				loadServerTags(edit.localId, edit.osmId);
			}
		}
	},
	{ immediate: true, deep: true }
);

async function loadServerTags(localId: number, osmId: number): Promise<void> {
	serverTagsLoading[localId] = true;
	try {
		serverTags[localId] = await fetchServerTags(osmId);
	} finally {
		serverTagsLoading[localId] = false;
	}
}

// --- Rendering helpers -----------------------------------------------------

function iconFor(edit: PendingEdit): string {
	return getIconUrlForNode({
		id: edit.osmId,
		type: 'node',
		lat: edit.lat,
		lon: edit.lon,
		tags: edit.tags
	});
}

function titleFor(edit: PendingEdit): string {
	const tags = edit.tags;
	if (tags.name) return tags.name;
	switch (tags.emergency) {
		case 'fire_hydrant':
			return t('markerInfo.title.fireHydrant');
		case 'water_tank':
			return t('markerInfo.title.waterTank');
		case 'suction_point':
			return t('markerInfo.title.suctionPoint');
		case 'fire_water_pond':
			return t('markerInfo.title.fireWaterPond');
		default:
			return t('markerInfo.title.locationInfo');
	}
}

function actionLabel(edit: PendingEdit): string {
	return t(`pendingEdits.actions.${edit.action}`);
}

function tagSummary(edit: PendingEdit): string {
	// A short, human-scannable summary of the most relevant tags.
	const keys = Object.keys(edit.tags).filter((k) => k !== 'emergency' && k !== 'name');
	if (!keys.length) return t('pendingEdits.noExtraTags');
	return keys
		.slice(0, 3)
		.map((k) => `${k}=${edit.tags[k]}`)
		.join(', ');
}

function statusColor(status: PendingEdit['status']): string {
	switch (status) {
		case 'uploading':
			return 'primary';
		case 'conflict':
			return 'warning';
		case 'error':
			return 'danger';
		default:
			return 'medium';
	}
}

// --- Actions ---------------------------------------------------------------

async function syncNow(): Promise<void> {
	if (!isOnline.value) {
		const toast = await toastController.create({
			message: t('pendingEdits.offlineHint'),
			duration: 3000
		});
		await toast.present();
		return;
	}
	await store.sync();
}

async function confirmDiscard(edit: PendingEdit): Promise<void> {
	if (edit.localId == null) return;
	const alert = await alertController.create({
		header: t('pendingEdits.discardDialog.title'),
		message: t('pendingEdits.discardDialog.message'),
		buttons: [
			{ text: t('common.cancel'), role: 'cancel' },
			{
				text: t('pendingEdits.actions.discard'),
				role: 'destructive',
				handler: () => store.discard(edit.localId as number)
			}
		]
	});
	await alert.present();
}
</script>

<style scoped>
.empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	text-align: center;
	padding: 48px 24px;
	gap: 8px;
}

.empty-icon {
	font-size: 64px;
	color: var(--ion-color-success);
}

.offline-hint {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 16px;
	color: var(--md-sys-on-surface-variant);
	font-size: 0.9rem;
}

.type-icon {
	height: 28px;
	width: 28px;
	object-fit: contain;
}

.status-chip {
	font-size: 0.75rem;
	height: 22px;
}

.error-line {
	color: var(--ion-color-danger);
	white-space: normal;
}

.actions-row {
	--min-height: 40px;
	font-size: 0.85rem;
}

.conflict-box {
	padding: 8px 16px 16px;
	background: var(--ion-color-light);
}

.conflict-cols {
	display: flex;
	gap: 16px;
	flex-wrap: wrap;
}

.conflict-col {
	flex: 1 1 140px;
	min-width: 140px;
}

.conflict-col h4 {
	margin: 4px 0;
	font-size: 0.8rem;
	color: var(--md-sys-on-surface-variant);
	text-transform: uppercase;
	letter-spacing: 0.03em;
}

.conflict-col ul {
	list-style: none;
	margin: 0;
	padding: 0;
	font-size: 0.85rem;
	word-break: break-word;
}

.tag-key {
	font-weight: 600;
}

.muted {
	color: var(--md-sys-on-surface-variant);
	font-size: 0.85rem;
}

.conflict-actions {
	display: flex;
	gap: 8px;
	margin-top: 12px;
}

.sync-footer {
	padding: 16px;
}
</style>
