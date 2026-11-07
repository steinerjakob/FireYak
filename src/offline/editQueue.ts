import * as OSM from 'osm-api';
import { version } from '@/../package.json';
import { fetchElementById } from '@/mapHandler/overPassApi';
import { useNetworkStatus } from '@/composable/networkStatus';
import {
	PendingEdit,
	addPendingEdit,
	getAllPendingEdits,
	getPendingEdit,
	getPendingEditsByStatus,
	updatePendingEdit,
	deletePendingEdit,
	getMapNodeById,
	storeMapNodes,
	deleteMapNode,
	hardDeleteMapNodes,
	clearDeletedMapNode
} from '@/mapHandler/databaseHandler';
import { markerCacheVersion } from '@/mapHandler/markerHandler';
import { toRef, type OsmType } from '@/helper/osmRef';
import { getFeatureForEdit, rememberDevServerCreate, uploadChange } from '@/services/osmWrite';
import {
	describeEdit,
	isAreaType,
	isMarkerTags,
	mergeTagEdit,
	toCacheElement
} from '@/helper/osmElement';

// ---------------------------------------------------------------------------
// Offline edit queue + sync engine (§1.3)
//
// While offline (or when an online upload fails with a network error) marker
// edits are written to the `pendingEdits` store instead of being uploaded, and
// the local cache is updated optimistically so the map reflects the change
// immediately. The queue is drained (FIFO) on app start, on every
// offline→online transition, and via a manual "Sync now" button.
// ---------------------------------------------------------------------------

/**
 * Next temp ID handed out to an offline `create`. Temp IDs are negative so they
 * can never collide with real OSM IDs. Initialised at startup from the most
 * negative temp ID still queued (see {@link initEditQueue}) so IDs stay unique
 * across app restarts while creates are still pending.
 */
let nextTempId = -1;

/** Guards {@link processQueue} against overlapping runs (startup + onOnline). */
let isSyncing = false;

const { isOnline } = useNetworkStatus();

/** Changeset comment for a queued edit, matching the online save path's wording. */
function commentFor(edit: PendingEdit): string {
	return `${describeEdit(edit.action, edit.elementType ?? 'node', edit.baseTags, edit.tags)} via FireYak ${version} (offline sync)`;
}

/** Element type of a queued edit; rows from before area editing are nodes. */
function typeOf(edit: Pick<PendingEdit, 'elementType'>): OsmType {
	return edit.elementType ?? 'node';
}

/**
 * Heuristic: did this error come from the network being down rather than from a
 * genuine server rejection? `fetch()` rejects with a `TypeError` ("Failed to
 * fetch" / "Load failed" / "NetworkError") when the request never reaches a
 * server — distinct from an HTTP error response, which `osm-api` surfaces as a
 * non-`TypeError`. We also treat "we already know we're offline" as a network
 * error so a mid-run disconnect re-queues cleanly rather than erroring out.
 */
export function isNetworkError(e: unknown): boolean {
	if (!isOnline.value) return true;
	if (e instanceof TypeError) return true;
	const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
	return (
		msg.includes('failed to fetch') ||
		msg.includes('networkerror') ||
		msg.includes('load failed') ||
		msg.includes('network request failed')
	);
}

/** True if a delete failed only because the node was already gone on the server. */
function isAlreadyDeleted(e: unknown): boolean {
	// osm-api puts the HTTP status in `cause`; our production read in `status`.
	const status =
		(e as { status?: number; cause?: unknown })?.status ?? (e as { cause?: unknown })?.cause;
	if (status === 410 || status === 404) return true;
	const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
	return msg.includes('410') || msg.includes('gone') || msg.includes('already deleted');
}

/**
 * Initialises the temp-ID counter from the queued creates so a fresh session
 * keeps handing out unique negative IDs. Call once on startup before enqueueing.
 */
export async function initEditQueue(): Promise<void> {
	const edits = await getAllPendingEdits();
	const min = edits.reduce((acc, e) => Math.min(acc, e.osmId), 0);
	nextTempId = min < 0 ? min - 1 : -1;
}

export interface EnqueueInput {
	action: PendingEdit['action'];
	/**
	 * Element type the edit targets; defaults to `'node'`. Creates are always
	 * nodes. Ways/relations (pond areas) only accept `update` — a delete would
	 * remove the water body itself, so it is rejected.
	 */
	elementType?: OsmType;
	/** Outline of an area, carried into the optimistic cache entry. */
	outline?: GeoJSON.Geometry;
	/** Real OSM ID for update/delete; ignored for create (a temp ID is assigned). */
	osmId: number;
	baseTags: Record<string, string> | null;
	tags: Record<string, string>;
	lat: number;
	lon: number;
}

/**
 * Writes a queued edit and updates the cache optimistically.
 *
 * **Temp-node coalescing:** an update/delete that targets a node which is itself
 * still a pending offline `create` (negative `osmId`) must never reach the OSM
 * API — that node does not exist on the server yet. Instead we fold the change
 * into the queue: an update rewrites the pending create's tags/coords in place,
 * and a delete drops the pending create entirely (and hard-deletes its temp node
 * from the cache). Either way no new queue entry is added.
 */
export async function enqueueEdit(input: EnqueueInput): Promise<void> {
	const elementType: OsmType = input.action === 'create' ? 'node' : (input.elementType ?? 'node');
	if (input.action === 'delete' && isAreaType(elementType)) {
		throw new Error(`Refusing to delete ${elementType} ${input.osmId}: areas only get tag edits`);
	}

	// --- Coalesce edits that target a not-yet-synced offline create ---------
	if (input.action !== 'create' && input.osmId < 0) {
		const create = (await getAllPendingEdits()).find((e) => e.osmId === input.osmId);

		if (input.action === 'delete') {
			// The create never hit OSM: dropping the queue entry and the temp node
			// makes it as if the marker was never added.
			if (create?.localId != null) await deletePendingEdit(create.localId);
			await hardDeleteMapNodes([toRef('node', input.osmId)]);
			markerCacheVersion.value++;
			return;
		}

		// update → mutate the pending create's payload in place.
		if (create?.localId != null) {
			await updatePendingEdit(create.localId, {
				tags: input.tags,
				lat: input.lat,
				lon: input.lon
			});
		}
		await storeMapNodes([toCacheElement('node', input.osmId, input.lat, input.lon, input.tags)]);
		markerCacheVersion.value++;
		return;
	}

	// --- Normal enqueue -----------------------------------------------------
	const osmId = input.action === 'create' ? nextTempId-- : input.osmId;

	await addPendingEdit({
		action: input.action,
		elementType,
		osmId,
		baseTags: input.baseTags,
		tags: input.tags,
		lat: input.lat,
		lon: input.lon,
		createdAt: Date.now(),
		status: 'pending'
	});

	// Optimistic cache update so the map reflects the edit immediately. An
	// update that leaves no marker tags (a pond area whose fire-pond flag was
	// removed) tombstones the entry, exactly like a delete.
	if (input.action === 'delete' || !isMarkerTags(input.tags)) {
		await deleteMapNode(toRef(elementType, osmId));
	} else {
		// A water area flagged as fire pond may carry a tombstone from an
		// earlier local unflag — lift it, or the store below stays hidden.
		if (isAreaType(elementType)) await clearDeletedMapNode(toRef(elementType, osmId));
		await storeMapNodes([
			toCacheElement(elementType, osmId, input.lat, input.lon, input.tags, input.outline)
		]);
	}
	markerCacheVersion.value++;
}

// ---------------------------------------------------------------------------
// Upload primitives — mirror markerEditStore's online osm-api usage, one
// changeset per edit (acceptable for v1). Comments keep the repo's format with
// the version suffix, tagged as an offline sync.
// ---------------------------------------------------------------------------

async function uploadCreate(edit: PendingEdit): Promise<number> {
	const change: OSM.OsmChange = {
		create: [{ type: 'node', id: -1, lat: edit.lat, lon: edit.lon, tags: edit.tags } as never],
		modify: [],
		delete: []
	};
	const result = await uploadChange({ comment: commentFor(edit) }, change, { interactive: false });
	const changesetId = parseInt(Object.keys(result)[0]);
	const diff = result[changesetId].diffResult;
	if (!diff.node || diff.node[-1] == null) {
		throw new Error('Create changeset returned no new node ID');
	}
	const newId = diff.node[-1].newId;
	rememberDevServerCreate('node', newId);
	return newId;
}

/**
 * Reads the element a queued edit targets from the OSM API — the same source
 * the upload is built from, so the conflict check can't be fooled by a lagging
 * Overpass replica. `null` when it no longer exists (404/410).
 */
async function fetchServerElement(edit: PendingEdit): Promise<OSM.OsmFeature | null> {
	try {
		return await getFeatureForEdit(typeOf(edit), edit.osmId);
	} catch (e) {
		if (isAlreadyDeleted(e)) return null;
		throw e;
	}
}

/** Uploads `tags` onto `element` (the server version just read). */
async function uploadUpdate(
	edit: PendingEdit,
	element: OSM.OsmFeature,
	tags: Record<string, string>
): Promise<void> {
	// Areas keep their geometry (way nodes / relation members) untouched; only
	// nodes are moved.
	if (element.type === 'node') {
		element.lat = edit.lat;
		element.lon = edit.lon;
	}
	element.tags = tags;
	const change: OSM.OsmChange = { create: [], modify: [element], delete: [] };
	await uploadChange({ comment: commentFor(edit) }, change, { interactive: false });
}

async function uploadDelete(edit: PendingEdit): Promise<void> {
	if (isAreaType(typeOf(edit))) {
		throw new Error(`Refusing to delete ${typeOf(edit)} ${edit.osmId}: areas only get tag edits`);
	}
	const node = await getFeatureForEdit('node', edit.osmId);
	const change: OSM.OsmChange = { create: [], modify: [], delete: [node] };
	await uploadChange({ comment: commentFor(edit) }, change, { interactive: false });
}

/**
 * Rewrites a synced create's temp ID to its real OSM ID everywhere it is still
 * referenced: the cached node (re-keyed, since `id` is the store key) and any
 * later queue entries that were enqueued against the temp ID.
 */
async function remapTempId(tempId: number, newId: number): Promise<void> {
	const node = await getMapNodeById(toRef('node', tempId));
	if (node) {
		await storeMapNodes([{ ...node, id: newId }]);
		await hardDeleteMapNodes([toRef('node', tempId)]);
		markerCacheVersion.value++;
	}

	// Defensive: coalescing normally folds later edits into the create, but any
	// queue entry still pointing at the temp ID is repointed to the real one.
	for (const e of await getAllPendingEdits()) {
		if (e.osmId === tempId && e.localId != null) {
			await updatePendingEdit(e.localId, { osmId: newId, baseTags: null });
		}
	}
}

/**
 * Drains the queue in FIFO order. Per edit: mark `uploading`, attempt the
 * upload, then remove it on success. Update conflicts (server tags no longer
 * match the snapshot, or the node vanished) are parked as `conflict` for manual
 * resolution and never auto-overwritten. A network error re-queues the current
 * edit as `pending` and stops the run (we're offline again); any other error
 * marks the edit `error` with the message and moves on.
 *
 * @returns the number of edits successfully synced in this run.
 */
export async function processQueue(): Promise<number> {
	if (isSyncing) return 0;
	isSyncing = true;
	let synced = 0;

	try {
		const edits = await getPendingEditsByStatus('pending');
		for (const edit of edits) {
			if (edit.localId == null) continue;
			await updatePendingEdit(edit.localId, { status: 'uploading', errorMessage: undefined });

			try {
				switch (edit.action) {
					case 'create': {
						const newId = await uploadCreate(edit);
						await remapTempId(edit.osmId, newId);
						break;
					}
					case 'update': {
						// Compare against the element the upload is built from (OSM API),
						// not Overpass, which can lag behind another mapper's edit.
						const server = await fetchServerElement(edit);
						if (!server) {
							await updatePendingEdit(edit.localId, { status: 'conflict' });
							continue;
						}
						// Apply only our own changes on top of the current tags; a key
						// someone else changed differently is a conflict. Never silently
						// clobber a concurrent edit.
						const merged = edit.baseTags
							? mergeTagEdit(edit.baseTags, edit.tags, server.tags ?? {})
							: { tags: edit.tags };
						if ('conflicts' in merged) {
							await updatePendingEdit(edit.localId, { status: 'conflict' });
							continue;
						}
						await uploadUpdate(edit, server, merged.tags);
						break;
					}
					case 'delete': {
						try {
							await uploadDelete(edit);
						} catch (e) {
							if (!isAlreadyDeleted(e)) throw e; // 410/404 → already gone, treat as success
						}
						break;
					}
				}
				await deletePendingEdit(edit.localId);
				synced++;
			} catch (e) {
				if (isNetworkError(e)) {
					await updatePendingEdit(edit.localId, { status: 'pending' });
					return synced; // still offline — stop, resume on next reconnect
				}
				await updatePendingEdit(edit.localId, { status: 'error', errorMessage: String(e) });
			}
		}
	} finally {
		isSyncing = false;
	}

	return synced;
}

/**
 * Conflict resolution: keep the local edit. Re-snapshots `baseTags` to the
 * server's current tags so the next sync passes the conflict check, then
 * re-queues as `pending`.
 */
export async function applyMineAnyway(localId: number): Promise<void> {
	const edit = await getPendingEdit(localId);
	if (!edit) return;
	const server = await fetchServerElement(edit);
	await updatePendingEdit(localId, {
		status: 'pending',
		baseTags: server?.tags ?? null,
		errorMessage: undefined
	});
}

/**
 * Conflict/error resolution: drop the queued edit and restore the cache to the
 * server's state. A discarded offline create removes the temp node entirely;
 * otherwise the server node is re-fetched into the cache so the map stops
 * showing the local (now abandoned) version.
 */
export async function discardEdit(localId: number): Promise<void> {
	const edit = await getPendingEdit(localId);
	if (!edit) return;
	await deletePendingEdit(localId);

	if (edit.action === 'create') {
		await hardDeleteMapNodes([toRef(edit.elementType, edit.osmId)]);
		markerCacheVersion.value++;
		return;
	}

	// A discarded delete/unflag tombstoned the element. Lift the tombstone
	// first and unconditionally: even if the lookup below fails (offline), the
	// next normal data load then restores the element instead of it staying
	// hidden for good.
	await clearDeletedMapNode(toRef(typeOf(edit), edit.osmId));
	markerCacheVersion.value++;

	const server = await fetchElementById(typeOf(edit), edit.osmId).catch(() => null);
	if (server) {
		await storeMapNodes([server]);
		markerCacheVersion.value++;
	}
}

/** Sets an errored edit back to `pending` so the next sync retries it. */
export async function retryEdit(localId: number): Promise<void> {
	await updatePendingEdit(localId, { status: 'pending', errorMessage: undefined });
}

/** Fetches the server's current tags for an element (used by the conflict view). */
export async function fetchServerTags(
	osmId: number,
	elementType: OsmType = 'node'
): Promise<Record<string, string> | null> {
	try {
		const server = await getFeatureForEdit(elementType, osmId);
		return server.tags ?? null;
	} catch {
		return null;
	}
}
