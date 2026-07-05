import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { toastController } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import { PendingEdit, getAllPendingEdits } from '@/mapHandler/databaseHandler';
import {
	initEditQueue,
	processQueue,
	applyMineAnyway,
	discardEdit,
	retryEdit
} from '@/offline/editQueue';

/**
 * Reactive facade over the offline edit queue (`src/offline/editQueue.ts`). Holds
 * the queued edits for the UI, exposes the pending-count badge, and wraps the
 * sync engine so a toast is shown after a successful sync. All mutations refresh
 * the reactive list afterwards.
 */
export const usePendingEditsStore = defineStore('pendingEdits', () => {
	const edits = ref<PendingEdit[]>([]);
	let initialized = false;

	const { t } = useI18n();

	/** Total queued edits — drives the settings badge. */
	const pendingCount = computed(() => edits.value.length);

	/** Reloads the reactive list from IndexedDB. */
	async function refresh(): Promise<void> {
		edits.value = await getAllPendingEdits();
	}

	/**
	 * Runs the sync engine and refreshes the list. Shows a toast only when
	 * something was actually synced (so a no-op run stays silent).
	 */
	async function sync(): Promise<void> {
		const synced = await processQueue();
		await refresh();
		if (synced > 0) {
			const toast = await toastController.create({
				message: t('pendingEdits.messages.synced', { count: synced }),
				duration: 2500,
				color: 'success'
			});
			await toast.present();
		}
	}

	/** Startup: init the temp-ID counter, load the list, then attempt a sync. */
	async function init(): Promise<void> {
		if (initialized) return;
		initialized = true;
		await initEditQueue();
		await refresh();
		void sync();
	}

	async function retry(localId: number): Promise<void> {
		await retryEdit(localId);
		await sync();
	}

	async function discard(localId: number): Promise<void> {
		await discardEdit(localId);
		await refresh();
	}

	async function applyMine(localId: number): Promise<void> {
		await applyMineAnyway(localId);
		await sync();
	}

	return {
		edits,
		pendingCount,
		init,
		refresh,
		sync,
		retry,
		discard,
		applyMine
	};
});
