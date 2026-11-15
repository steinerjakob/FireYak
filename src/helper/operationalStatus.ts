/**
 * Whether a water source can be used (issue #118). Pure: tags in, status out.
 *
 * The OSM wiki (Tag:emergency=fire_hydrant) says an out-of-service hydrant
 * takes the lifecycle prefix: `emergency=fire_hydrant` is replaced by
 * `disused:emergency=fire_hydrant`. That is what FireYak writes. It also reads
 * `operational_status`, which other mappers use:
 *
 * - `outOfService`: `disused:emergency=*` instead of `emergency=*`, or
 *   `operational_status=out_of_order` / `broken` / `closed` / …
 * - `caution`: `operational_status=needs_maintenance` / `restricted`, or a value
 *   we don't recognise — never read an unknown value as OK, and never hide a
 *   source on a value we don't understand
 * - `ok`: otherwise
 *
 * A US "dry hydrant" (`fire_hydrant:type=pipe`) is a working suction pipe and
 * has nothing to do with this status.
 */
export type SourceStatus = 'ok' | 'caution' | 'outOfService';

export const OPERATIONAL_STATUS_KEY = 'operational_status';
export const EMERGENCY_KEY = 'emergency';
export const DISUSED_EMERGENCY_KEY = 'disused:emergency';

/** `emergency` values FireYak shows; only these are read from `disused:emergency`. */
export const WATER_SOURCE_TYPES = [
	'fire_hydrant',
	'suction_point',
	'water_tank',
	'fire_water_pond'
] as const;

/** Value of the edit form's status field for "out of service" (written as lifecycle prefix). */
export const OUT_OF_SERVICE_VALUE = 'out_of_order';
/** Values the edit form offers; "working" (empty) removes both markers. */
export const EDITABLE_STATUS_VALUES = ['needs_maintenance', OUT_OF_SERVICE_VALUE] as const;

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

type Tags = Record<string, string> | undefined;

/** A disused water source: `disused:emergency=<type>` and no `emergency`. */
export function isDisused(tags: Tags): boolean {
	const disused = tags?.[DISUSED_EMERGENCY_KEY];
	return (
		!tags?.[EMERGENCY_KEY] &&
		disused != null &&
		(WATER_SOURCE_TYPES as readonly string[]).includes(disused)
	);
}

/**
 * The water-source type of an element, whether in service (`emergency`) or out
 * of service (`disused:emergency`). Use this wherever the type decides icon,
 * title or behaviour, so a disused hydrant is still a hydrant.
 */
export function emergencyOf(tags: Tags): string | undefined {
	return tags?.[EMERGENCY_KEY] ?? (isDisused(tags) ? tags?.[DISUSED_EMERGENCY_KEY] : undefined);
}

function normalise(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_');
}

/** True for an `operational_status` value that means "cannot be used". */
export function isOutOfServiceValue(value: string | undefined): boolean {
	return value != null && OUT_OF_SERVICE_VALUES.has(normalise(value));
}

export function sourceStatus(tags: Tags): SourceStatus {
	if (isDisused(tags)) return 'outOfService';
	const raw = tags?.[OPERATIONAL_STATUS_KEY]?.trim();
	if (!raw) return 'ok';
	// Multiple values (`a;b`): the worst one wins.
	const values = raw.split(';').map(normalise);
	if (values.some((v) => OUT_OF_SERVICE_VALUES.has(v))) return 'outOfService';
	if (values.every((v) => !v || OK_VALUES.has(v))) return 'ok';
	return 'caution';
}

/**
 * Edit-form view of a tag set: a disused source is shown with its plain
 * `emergency` type (the form branches on it) plus `outOfService: true`.
 */
export function splitLifecycle(tags: Record<string, string>): {
	tags: Record<string, string>;
	outOfService: boolean;
} {
	if (!isDisused(tags)) return { tags: { ...tags }, outOfService: false };
	const { [DISUSED_EMERGENCY_KEY]: type, ...rest } = tags;
	return { tags: { ...rest, [EMERGENCY_KEY]: type }, outOfService: true };
}

/**
 * Inverse of {@link splitLifecycle} for saving: out of service moves the type
 * to `disused:emergency`, as the wiki asks. An `operational_status` that says
 * the same thing is dropped then, so the object is not tagged twice.
 */
export function applyLifecycle(
	tags: Record<string, string>,
	outOfService: boolean
): Record<string, string> {
	const type = tags[EMERGENCY_KEY];
	if (!outOfService || !type) return { ...tags };
	const { [EMERGENCY_KEY]: _type, ...rest } = tags;
	if (isOutOfServiceValue(rest[OPERATIONAL_STATUS_KEY])) delete rest[OPERATIONAL_STATUS_KEY];
	return { ...rest, [DISUSED_EMERGENCY_KEY]: type };
}
