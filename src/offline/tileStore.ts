import { openDB, type IDBPDatabase } from 'idb';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

/**
 * Persistent store for downloaded map tiles and style assets (glyphs/sprites).
 *
 * Two implementations sit behind the {@link tileStore} singleton:
 *   - web/PWA: everything in a dedicated `FireTiles` IndexedDB DB (kept
 *     separate from the marker DB so that stays small).
 *   - native (iOS/Android): tile blobs on the filesystem under `Directory.Data`
 *     with a small IndexedDB index for reference-counting/size bookkeeping —
 *     avoids WKWebView IndexedDB size pressure on iOS.
 *
 * Tiles are reference-counted per offline area: a tile shared by two overlapping
 * areas carries both area ids and only its blob is deleted once the last area
 * referencing it is removed.
 */
export interface TileStore {
	get(source: string, z: number, x: number, y: number): Promise<Blob | null>;
	/** Stores a tile blob. `areaId` adds a reference; write-through puts pass none. */
	put(
		source: string,
		z: number,
		x: number,
		y: number,
		data: Blob,
		opts?: { areaId?: number }
	): Promise<void>;
	has(source: string, z: number, x: number, y: number): Promise<boolean>;
	addAreaRef(source: string, z: number, x: number, y: number, areaId: number): Promise<void>;
	/** Removes `areaId` refs; deletes tiles whose ref list becomes empty. */
	deleteArea(areaId: number): Promise<void>;
	/**
	 * Removes `areaId` refs from tiles of one source; deletes tiles whose ref
	 * list becomes empty. `refsRemoved` counts every tile the ref was removed
	 * from; `bytesFreed` sums only fully deleted blobs (shared tiles survive).
	 */
	deleteAreaSource(
		areaId: number,
		source: string
	): Promise<{ refsRemoved: number; bytesFreed: number }>;
	/** Total bytes held by all tiles (diagnostics / settings display). */
	sizeBytes(): Promise<number>;
	/** Cache-first read of a style asset (glyph range / sprite json/png) by path. */
	getAsset(path: string): Promise<Blob | null>;
	/** Stores a style asset blob under its request path. */
	putAsset(path: string, data: Blob): Promise<void>;
}

const tileKey = (s: string, z: number, x: number, y: number) => `${s}/${z}/${x}/${y}`;

interface TileRecord {
	blob: Blob;
	areaIds: number[];
	fetchedAt: number;
	/** Cached `blob.size` so `sizeBytes()`/deletion don't have to deserialise blobs. */
	size: number;
}

// ---------------------------------------------------------------------------
// Web / PWA implementation — IndexedDB `FireTiles`
// ---------------------------------------------------------------------------

function openTileDb(): Promise<IDBPDatabase> {
	return openDB('FireTiles', 1, {
		upgrade(db) {
			// Out-of-line key `${source}/${z}/${x}/${y}`; multiEntry index over the
			// per-tile `areaIds` array powers area deletion via a single cursor.
			const tiles = db.createObjectStore('tiles');
			tiles.createIndex('areaIds', 'areaIds', { multiEntry: true });
			// Style assets keyed by their request path (small, global, not ref-counted).
			db.createObjectStore('assets');
		}
	});
}

const idbTileStore: TileStore = {
	async get(s, z, x, y) {
		const rec = (await (await tileDbPromise()).get('tiles', tileKey(s, z, x, y))) as
			| TileRecord
			| undefined;
		return rec?.blob ?? null;
	},

	async put(s, z, x, y, blob, opts = {}) {
		const db = await tileDbPromise();
		const k = tileKey(s, z, x, y);
		const existing = (await db.get('tiles', k)) as TileRecord | undefined;
		const areaIds = new Set<number>(existing?.areaIds ?? []);
		if (opts.areaId != null) areaIds.add(opts.areaId);
		const rec: TileRecord = {
			blob,
			areaIds: [...areaIds],
			fetchedAt: Date.now(),
			size: blob.size
		};
		await db.put('tiles', rec, k);
	},

	async has(s, z, x, y) {
		const key = await (await tileDbPromise()).getKey('tiles', tileKey(s, z, x, y));
		return key !== undefined;
	},

	async addAreaRef(s, z, x, y, areaId) {
		const db = await tileDbPromise();
		const k = tileKey(s, z, x, y);
		const existing = (await db.get('tiles', k)) as TileRecord | undefined;
		if (!existing) return;
		if (existing.areaIds.includes(areaId)) return;
		await db.put('tiles', { ...existing, areaIds: [...existing.areaIds, areaId] }, k);
	},

	async deleteArea(areaId) {
		const db = await tileDbPromise();
		const tx = db.transaction('tiles', 'readwrite');
		const index = tx.store.index('areaIds');
		let cursor = await index.openCursor(IDBKeyRange.only(areaId));
		while (cursor) {
			const rec = cursor.value as TileRecord;
			const remaining = rec.areaIds.filter((id) => id !== areaId);
			if (remaining.length === 0) {
				await cursor.delete();
			} else {
				await cursor.update({ ...rec, areaIds: remaining });
			}
			cursor = await cursor.continue();
		}
		await tx.done;
	},

	async deleteAreaSource(areaId, source) {
		const db = await tileDbPromise();
		const prefix = `${source}/`;
		let refsRemoved = 0;
		let bytesFreed = 0;
		const tx = db.transaction('tiles', 'readwrite');
		const index = tx.store.index('areaIds');
		let cursor = await index.openCursor(IDBKeyRange.only(areaId));
		while (cursor) {
			if (String(cursor.primaryKey).startsWith(prefix)) {
				const rec = cursor.value as TileRecord;
				const remaining = rec.areaIds.filter((id) => id !== areaId);
				refsRemoved++;
				if (remaining.length === 0) {
					bytesFreed += rec.size ?? 0;
					await cursor.delete();
				} else {
					await cursor.update({ ...rec, areaIds: remaining });
				}
			}
			cursor = await cursor.continue();
		}
		await tx.done;
		return { refsRemoved, bytesFreed };
	},

	async sizeBytes() {
		const db = await tileDbPromise();
		let total = 0;
		let cursor = await db.transaction('tiles').store.openCursor();
		while (cursor) {
			total += (cursor.value as TileRecord).size ?? 0;
			cursor = await cursor.continue();
		}
		return total;
	},

	async getAsset(path) {
		const blob = (await (await tileDbPromise()).get('assets', path)) as Blob | undefined;
		return blob ?? null;
	},

	async putAsset(path, data) {
		await (await tileDbPromise()).put('assets', data, path);
	}
};

let _tileDb: Promise<IDBPDatabase> | null = null;
function tileDbPromise(): Promise<IDBPDatabase> {
	if (!_tileDb) _tileDb = openTileDb();
	return _tileDb;
}

// ---------------------------------------------------------------------------
// Native implementation — Filesystem blobs + IndexedDB index
// ---------------------------------------------------------------------------

const TILE_DIR = 'offline-tiles';
const tilePath = (s: string, z: number, x: number, y: number) =>
	`${TILE_DIR}/${s}/${z}/${x}/${y}.bin`;

interface NativeIndexRecord {
	areaIds: number[];
	size: number;
}

function openNativeIndexDb(): Promise<IDBPDatabase> {
	return openDB('FireTilesIndex', 1, {
		upgrade(db) {
			const idx = db.createObjectStore('tileIndex');
			idx.createIndex('areaIds', 'areaIds', { multiEntry: true });
			db.createObjectStore('assets');
		}
	});
}

let _nativeDb: Promise<IDBPDatabase> | null = null;
function nativeDbPromise(): Promise<IDBPDatabase> {
	if (!_nativeDb) _nativeDb = openNativeIndexDb();
	return _nativeDb;
}

/**
 * Capacitor's Filesystem API only moves strings, so tile bytes make a round-trip
 * through base64 on both write and read. The overhead is real (~33% larger
 * payload + encode/decode) but keeps large blobs out of WKWebView's IndexedDB,
 * which is the bigger risk on iOS. These helpers stream in 32 KB chunks so a
 * ~256 KB satellite tile doesn't blow the argument limit of `String.fromCharCode`.
 */
async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function base64ToBlob(b64: string): Blob {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes]);
}

const nativeTileStore: TileStore = {
	async get(s, z, x, y) {
		try {
			const res = await Filesystem.readFile({
				path: tilePath(s, z, x, y),
				directory: Directory.Data
			});
			// readFile returns base64 when no `encoding` is given.
			return base64ToBlob(res.data as string);
		} catch {
			return null; // not present
		}
	},

	async put(s, z, x, y, blob, opts = {}) {
		const db = await nativeDbPromise();
		const k = tileKey(s, z, x, y);
		await Filesystem.writeFile({
			path: tilePath(s, z, x, y),
			data: await blobToBase64(blob),
			directory: Directory.Data,
			recursive: true
		});
		const existing = (await db.get('tileIndex', k)) as NativeIndexRecord | undefined;
		const areaIds = new Set<number>(existing?.areaIds ?? []);
		if (opts.areaId != null) areaIds.add(opts.areaId);
		await db.put('tileIndex', { areaIds: [...areaIds], size: blob.size }, k);
	},

	async has(s, z, x, y) {
		const key = await (await nativeDbPromise()).getKey('tileIndex', tileKey(s, z, x, y));
		return key !== undefined;
	},

	async addAreaRef(s, z, x, y, areaId) {
		const db = await nativeDbPromise();
		const k = tileKey(s, z, x, y);
		const existing = (await db.get('tileIndex', k)) as NativeIndexRecord | undefined;
		if (!existing) return;
		if (existing.areaIds.includes(areaId)) return;
		await db.put('tileIndex', { ...existing, areaIds: [...existing.areaIds, areaId] }, k);
	},

	async deleteArea(areaId) {
		const db = await nativeDbPromise();
		const index = db.transaction('tileIndex').store.index('areaIds');
		const toDelete: string[] = [];
		let cursor = await index.openCursor(IDBKeyRange.only(areaId));
		while (cursor) {
			const rec = cursor.value as NativeIndexRecord;
			const remaining = rec.areaIds.filter((id) => id !== areaId);
			const key = cursor.primaryKey as string;
			if (remaining.length === 0) {
				toDelete.push(key);
			} else {
				await db.put('tileIndex', { ...rec, areaIds: remaining }, key);
			}
			cursor = await cursor.continue();
		}
		for (const key of toDelete) {
			await db.delete('tileIndex', key);
			try {
				await Filesystem.deleteFile({ path: `${TILE_DIR}/${key}.bin`, directory: Directory.Data });
			} catch {
				// File may already be gone — index removal is what matters.
			}
		}
	},

	async deleteAreaSource(areaId, source) {
		const db = await nativeDbPromise();
		const prefix = `${source}/`;
		let refsRemoved = 0;
		let bytesFreed = 0;
		const index = db.transaction('tileIndex').store.index('areaIds');
		const toDelete: { key: string; size: number }[] = [];
		let cursor = await index.openCursor(IDBKeyRange.only(areaId));
		while (cursor) {
			const key = cursor.primaryKey as string;
			if (key.startsWith(prefix)) {
				const rec = cursor.value as NativeIndexRecord;
				const remaining = rec.areaIds.filter((id) => id !== areaId);
				refsRemoved++;
				if (remaining.length === 0) {
					toDelete.push({ key, size: rec.size ?? 0 });
				} else {
					await db.put('tileIndex', { ...rec, areaIds: remaining }, key);
				}
			}
			cursor = await cursor.continue();
		}
		for (const { key, size } of toDelete) {
			await db.delete('tileIndex', key);
			bytesFreed += size;
			try {
				await Filesystem.deleteFile({ path: `${TILE_DIR}/${key}.bin`, directory: Directory.Data });
			} catch {
				// File may already be gone — index removal is what matters.
			}
		}
		return { refsRemoved, bytesFreed };
	},

	async sizeBytes() {
		const db = await nativeDbPromise();
		let total = 0;
		let cursor = await db.transaction('tileIndex').store.openCursor();
		while (cursor) {
			total += (cursor.value as NativeIndexRecord).size ?? 0;
			cursor = await cursor.continue();
		}
		return total;
	},

	async getAsset(path) {
		const blob = (await (await nativeDbPromise()).get('assets', path)) as Blob | undefined;
		return blob ?? null;
	},

	async putAsset(path, data) {
		// Assets are small and global — keep them in IndexedDB even on native.
		await (await nativeDbPromise()).put('assets', data, path);
	}
};

/** The active implementation, chosen once per session by platform. */
export const tileStore: TileStore = Capacitor.isNativePlatform() ? nativeTileStore : idbTileStore;
