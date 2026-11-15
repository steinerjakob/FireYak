/**
 * Operational status of a water source, read from the OSM `operational_status`
 * tag (issue #118). Pure: tags in, status out.
 *
 * - `outOfService`: cannot be used (`out_of_order`, `broken`, `closed`, …)
 * - `caution`: usable but faulty (`needs_maintenance`, `restricted`) or a value
 *   we don't recognise — never read an unknown value as OK, and never hide a
 *   source on a value we don't understand
 * - `ok`: no tag, or `operational`
 *
 * Note: a US "dry hydrant" (`fire_hydrant:type=pipe`) is a working suction pipe
 * and has nothing to do with this status.
 */
export type SourceStatus = 'ok' | 'caution' | 'outOfService';

export const OPERATIONAL_STATUS_KEY = 'operational_status';

/** Values FireYak offers in the edit form; "working" removes the tag. */
export const EDITABLE_STATUS_VALUES = ['needs_maintenance', 'out_of_order'] as const;

const OUT_OF_SERVICE_VALUES = new Set([
	'out_of_order',
	'out_of_service',
	'broken',
	'closed',
	'defective',
	'damaged',
	'unusable',
	'not_operational',
	'non_operational',
	'inoperative'
]);

const OK_VALUES = new Set(['operational', 'ok', 'working', 'yes']);

export function sourceStatus(tags: Record<string, string> | undefined): SourceStatus {
	const raw = tags?.[OPERATIONAL_STATUS_KEY]?.trim().toLowerCase();
	if (!raw) return 'ok';
	// Multiple values (`a;b`): the worst one wins.
	const values = raw.split(';').map((v) => v.trim().replace(/[\s-]+/g, '_'));
	if (values.some((v) => OUT_OF_SERVICE_VALUES.has(v))) return 'outOfService';
	if (values.every((v) => !v || OK_VALUES.has(v))) return 'ok';
	return 'caution';
}
