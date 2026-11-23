import { describe, expect, it } from 'vitest';
import {
	describeEdit,
	isFlagEdit,
	isMarkerTags,
	isUnflagEdit,
	withoutFirePondFlag
} from './osmElement';

describe('out-of-service edits (issue #118)', () => {
	const pond = { emergency: 'fire_water_pond', natural: 'water' };
	const disusedPond = { 'disused:emergency': 'fire_water_pond', natural: 'water' };

	it('keeps a disused source as a marker', () => {
		expect(isMarkerTags({ 'disused:emergency': 'fire_hydrant' })).toBe(true);
		expect(isMarkerTags({ natural: 'water' })).toBe(false);
	});

	it('does not read taking a pond out of service as removing its flag', () => {
		expect(isUnflagEdit(pond, disusedPond)).toBe(false);
		expect(isUnflagEdit(pond, { natural: 'water' })).toBe(true);
	});

	it('does not read putting a pond back into service as a new flag', () => {
		expect(isFlagEdit(disusedPond, pond)).toBe(false);
		expect(isFlagEdit({ natural: 'water' }, pond)).toBe(true);
	});

	it('describes the lifecycle change in the changeset comment', () => {
		const hydrant = { emergency: 'fire_hydrant' };
		const disused = { 'disused:emergency': 'fire_hydrant' };
		expect(describeEdit('update', 'node', hydrant, disused)).toBe(
			'Mark fire_hydrant as out of service'
		);
		expect(describeEdit('update', 'node', disused, hydrant)).toBe(
			'Mark fire_hydrant as back in service'
		);
		expect(describeEdit('update', 'way', pond, disusedPond)).toBe(
			'Mark fire_water_pond as out of service (way)'
		);
		expect(describeEdit('update', 'node', hydrant, { ...hydrant, ref: '1' })).toBe(
			'Update fire_hydrant'
		);
	});

	it('unflags an out-of-service pond area too, keeping its water tags', () => {
		expect(withoutFirePondFlag(disusedPond)).toEqual({ natural: 'water' });
		expect(withoutFirePondFlag(pond)).toEqual({ natural: 'water' });
		expect(isUnflagEdit(disusedPond, { natural: 'water' })).toBe(true);
		expect(describeEdit('update', 'way', disusedPond, { natural: 'water' })).toBe(
			'Remove fire_water_pond tag from water area (way)'
		);
		// Other disused features are left alone.
		const tank = { 'disused:emergency': 'water_tank' };
		expect(withoutFirePondFlag(tank)).toEqual(tank);
	});
});
