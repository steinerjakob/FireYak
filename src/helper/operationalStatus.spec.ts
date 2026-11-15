import { describe, expect, it } from 'vitest';
import { sourceStatus } from './operationalStatus';

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
});
