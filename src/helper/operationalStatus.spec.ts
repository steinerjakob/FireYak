import { describe, expect, it } from 'vitest';
import {
	applyLifecycle,
	emergencyOf,
	isDisused,
	sourceStatus,
	splitLifecycle
} from './operationalStatus';

describe('sourceStatus', () => {
	it('is ok without tags or without the status tag', () => {
		expect(sourceStatus(undefined)).toBe('ok');
		expect(sourceStatus({})).toBe('ok');
		expect(sourceStatus({ emergency: 'fire_hydrant' })).toBe('ok');
		expect(sourceStatus({ operational_status: '  ' })).toBe('ok');
	});

	it('is ok for operational', () => {
		expect(sourceStatus({ operational_status: 'operational' })).toBe('ok');
		expect(sourceStatus({ operational_status: 'Operational' })).toBe('ok');
	});

	it.each(['out_of_order', 'broken', 'closed', 'Out of order', 'out-of-order'])(
		'is out of service for %s',
		(value) => {
			expect(sourceStatus({ operational_status: value })).toBe('outOfService');
		}
	);

	it.each(['needs_maintenance', 'restricted', 'something_new'])('is caution for %s', (value) => {
		expect(sourceStatus({ operational_status: value })).toBe('caution');
	});

	it('takes the worst of several values', () => {
		expect(sourceStatus({ operational_status: 'needs_maintenance;broken' })).toBe('outOfService');
		expect(sourceStatus({ operational_status: 'operational;needs_maintenance' })).toBe('caution');
	});

	it('ignores a dry hydrant type', () => {
		expect(sourceStatus({ emergency: 'fire_hydrant', 'fire_hydrant:type': 'pipe' })).toBe('ok');
	});

	it('is out of service for a disused water source (wiki lifecycle prefix)', () => {
		expect(sourceStatus({ 'disused:emergency': 'fire_hydrant' })).toBe('outOfService');
		expect(sourceStatus({ 'disused:emergency': 'fire_water_pond' })).toBe('outOfService');
	});

	it('does not read other disused emergency features as water sources', () => {
		expect(isDisused({ 'disused:emergency': 'phone' })).toBe(false);
		expect(emergencyOf({ 'disused:emergency': 'phone' })).toBeUndefined();
	});

	it('prefers the live tag when both are present', () => {
		const tags = { emergency: 'fire_hydrant', 'disused:emergency': 'fire_hydrant' };
		expect(isDisused(tags)).toBe(false);
		expect(sourceStatus(tags)).toBe('ok');
	});
});

describe('emergencyOf', () => {
	it('reads emergency, then disused:emergency', () => {
		expect(emergencyOf({ emergency: 'water_tank' })).toBe('water_tank');
		expect(emergencyOf({ 'disused:emergency': 'suction_point' })).toBe('suction_point');
		expect(emergencyOf({ amenity: 'fire_station' })).toBeUndefined();
		expect(emergencyOf(undefined)).toBeUndefined();
	});
});

describe('splitLifecycle / applyLifecycle', () => {
	it('round-trips a disused hydrant', () => {
		const tags = { 'disused:emergency': 'fire_hydrant', 'fire_hydrant:type': 'pillar' };
		const split = splitLifecycle(tags);
		expect(split).toEqual({
			tags: { emergency: 'fire_hydrant', 'fire_hydrant:type': 'pillar' },
			outOfService: true
		});
		expect(applyLifecycle(split.tags, true)).toEqual(tags);
	});

	it('leaves an in-service source unchanged', () => {
		const tags = { emergency: 'fire_hydrant', operational_status: 'needs_maintenance' };
		expect(splitLifecycle(tags)).toEqual({ tags, outOfService: false });
		expect(applyLifecycle(tags, false)).toEqual(tags);
	});

	it('restores a disused source to service', () => {
		const { tags } = splitLifecycle({ 'disused:emergency': 'water_tank' });
		expect(applyLifecycle(tags, false)).toEqual({ emergency: 'water_tank' });
	});

	it('drops a duplicate out-of-service operational_status, keeps others', () => {
		expect(
			applyLifecycle({ emergency: 'fire_hydrant', operational_status: 'broken' }, true)
		).toEqual({ 'disused:emergency': 'fire_hydrant' });
		expect(
			applyLifecycle({ emergency: 'fire_hydrant', operational_status: 'needs_maintenance' }, true)
		).toEqual({ 'disused:emergency': 'fire_hydrant', operational_status: 'needs_maintenance' });
	});
});
