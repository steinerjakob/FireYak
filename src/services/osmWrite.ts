import * as OSM from 'osm-api';
import { alertController, toastController } from '@ionic/vue';
import { OSM_EDITS_TARGET_OTHER_SERVER, OSM_DATA_API_URL } from '@/services/osmConfig';
import { toRef, type OsmRef, type OsmType } from '@/helper/osmRef';
import i18n from '@/plugins/i18n';

/**
 * All OSM reads-for-edit and uploads go through here, so preview builds can
 * test editing **existing** objects without touching any server.
 *
 * Preview builds (`OSM_EDITS_TARGET_OTHER_SERVER`) upload to the OSM dev
 * server, but every existing marker and water area comes from production OSM —
 * its id is missing on the dev server or belongs to an unrelated object there.
 * So for those builds:
 *
 * - **Creates** (negative ids) still really upload to the dev server.
 * - **Modify/delete** of an existing object is a **dry run**: the element is
 *   read (read-only) from the production API, the changeset is built exactly
 *   as it would be uploaded, and then shown to the tester instead of sent. The
 *   caller treats it as a success, so the map updates locally like after a
 *   real save — the whole flow can be reviewed end to end.
 *
 * Production and native builds are unaffected: they read and upload through
 * `osm-api` as before.
 */

/** True when changes to existing (production) objects must not be uploaded. */
export const DRY_RUN_EXISTING = OSM_EDITS_TARGET_OTHER_SERVER;

// Objects created on the dev server by this preview install. Their (positive)
// ids are real there, so editing them uploads for real instead of a dry run.
const DEV_CREATED_KEY = 'fireyak.devServerCreatedRefs';

function readDevCreated(): Set<OsmRef> {
	try {
		return new Set(JSON.parse(localStorage.getItem(DEV_CREATED_KEY) ?? '[]') as OsmRef[]);
	} catch {
		return new Set();
	}
}

/** Records an object this preview build created on the dev server. */
export function rememberDevServerCreate(type: OsmType, id: number): void {
	if (!DRY_RUN_EXISTING || id <= 0) return;
	const refs = readDevCreated();
	refs.add(toRef(type, id));
	try {
		localStorage.setItem(DEV_CREATED_KEY, JSON.stringify([...refs]));
	} catch {
		// Storage unavailable: the object is then treated as production (dry run).
	}
}

/** True for an existing production object, whose edits must be dry runs. */
function isProductionObject(type: OsmType, id: number): boolean {
	return DRY_RUN_EXISTING && id > 0 && !readDevCreated().has(toRef(type, id));
}

/** Server state of each element read for an edit, to describe the dry run. */
const readSnapshots = new Map<OsmRef, OSM.OsmFeature>();

/**
 * Reads the current server version of an element for editing. On preview
 * builds existing objects are read from the production API (read-only).
 */
export async function getFeatureForEdit(type: OsmType, id: number): Promise<OSM.OsmFeature> {
	let feature: OSM.OsmFeature;
	if (isProductionObject(type, id)) {
		const response = await fetch(`${OSM_DATA_API_URL}/api/0.6/${type}/${id}.json`);
		if (!response.ok) {
			const error = new Error(`OSM API ${response.status} reading ${type}/${id}`);
			(error as Error & { status?: number }).status = response.status;
			throw error;
		}
		const json = (await response.json()) as { elements?: OSM.OsmFeature[] };
		const element = json.elements?.[0];
		if (!element) throw new Error(`OSM API returned no ${type}/${id}`);
		feature = element;
	} else {
		[feature] = await OSM.getFeature(type, id);
	}
	readSnapshots.set(toRef(type, id), structuredClone(feature));
	return feature;
}

function touchesExisting(change: OSM.OsmChange): boolean {
	return [...change.modify, ...change.delete].some((f) => isProductionObject(f.type, f.id));
}

export interface UploadOptions {
	/** Show the dry-run summary as a dialog (interactive saves) or as a toast (background sync). */
	interactive: boolean;
}

/**
 * Uploads `change` — or, on preview builds when it modifies/deletes an existing
 * object, shows what would have been uploaded and returns an empty result.
 */
export async function uploadChange(
	tags: Record<string, string>,
	change: OSM.OsmChange,
	options: UploadOptions
): Promise<OSM.UploadResult> {
	if (!touchesExisting(change)) {
		return OSM.uploadChangeset(tags, change);
	}

	const summary = describeChange(tags, change);
	console.info('[FireYak preview] Dry run, not uploaded:\n' + summary, { tags, change });
	const t = i18n.global.t;
	if (options.interactive) {
		const alert = await alertController.create({
			header: t('markerEdit.dryRun.title'),
			message: `${t('markerEdit.dryRun.subtitle')}\n\n${summary}`,
			cssClass: 'dry-run-alert',
			buttons: [t('markerEdit.dryRun.ok')]
		});
		await alert.present();
		await alert.onDidDismiss();
	} else {
		const toast = await toastController.create({
			message: t('markerEdit.dryRun.toast'),
			duration: 3000,
			color: 'warning'
		});
		await toast.present();
	}
	// Same shape as a real result; there are no new ids to map.
	return { 0: { diffResult: {} } } as unknown as OSM.UploadResult;
}

/** Human-readable description of a changeset: tag diff and geometry per element. */
export function describeChange(tags: Record<string, string>, change: OSM.OsmChange): string {
	const lines: string[] = [];
	if (tags['comment']) lines.push(`Comment: ${tags['comment']}`);

	for (const feature of change.modify) {
		const before = readSnapshots.get(toRef(feature.type, feature.id));
		lines.push('', `Modify ${feature.type} ${feature.id} (v${feature.version})`);
		lines.push(...tagDiff(before?.tags ?? {}, feature.tags ?? {}));
		lines.push(geometryNote(before, feature));
	}
	for (const feature of change.delete) {
		lines.push('', `Delete ${feature.type} ${feature.id} (v${feature.version})`);
	}
	for (const feature of change.create) {
		lines.push('', `Create ${feature.type}`);
	}
	return lines.join('\n').trim();
}

function tagDiff(before: Record<string, string>, after: Record<string, string>): string[] {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const out: string[] = [];
	for (const key of keys) {
		if (!(key in after)) out.push(`  − ${key}=${before[key]}`);
		else if (!(key in before)) out.push(`  + ${key}=${after[key]}`);
		else if (before[key] !== after[key]) out.push(`  ~ ${key}=${before[key]} → ${after[key]}`);
	}
	return out.length ? out : ['  (no tag changes)'];
}

function geometryNote(before: OSM.OsmFeature | undefined, after: OSM.OsmFeature): string {
	if (after.type === 'node' && before?.type === 'node') {
		const moved = before.lat !== after.lat || before.lon !== after.lon;
		return moved
			? `  position → ${after.lat.toFixed(7)}, ${after.lon.toFixed(7)}`
			: '  position unchanged';
	}
	if (after.type === 'way' && before?.type === 'way') {
		const same =
			before.nodes.length === after.nodes.length &&
			before.nodes.every((n, i) => n === after.nodes[i]);
		return same ? `  geometry unchanged (${after.nodes.length} nodes)` : '  geometry CHANGED';
	}
	if (after.type === 'relation' && before?.type === 'relation') {
		const same =
			before.members.length === after.members.length &&
			before.members.every(
				(m, i) => m.ref === after.members[i].ref && m.type === after.members[i].type
			);
		return same ? `  members unchanged (${after.members.length})` : '  members CHANGED';
	}
	return '';
}
