import { describe, expect, it } from 'vitest';
import { mergeFreshElement, sameTags } from './markerRevalidation';

describe('sameTags', () => {
	it('compares keys and values, not order', () => {
		expect(sameTags({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
		expect(sameTags({ a: '1' }, { a: '2' })).toBe(false);
		expect(sameTags({ a: '1' }, { a: '1', b: '2' })).toBe(false);
		expect(sameTags(undefined, {})).toBe(true);
	});
});

describe('mergeFreshElement', () => {
	const cachedNode = {
		id: 1,
		type: 'node',
		ref: 'n1',
		tile: '10/1/1',
		lat: 48.1,
		lon: 15.2,
		tags: { emergency: 'fire_hydrant', 'fire_hydrant:type': 'pillar' }
	};

	it('reports no change when OSM matches the cache', () => {
		expect(
			mergeFreshElement(cachedNode, { ...cachedNode, tags: { ...cachedNode.tags } })
		).toBeNull();
	});

	it('takes the live tags of a node taken out of service', () => {
		const fresh = {
			id: 1,
			type: 'node',
			lat: 48.1,
			lon: 15.2,
			tags: { 'disused:emergency': 'fire_hydrant', 'fire_hydrant:type': 'pillar' }
		};
		const merged = mergeFreshElement(cachedNode, fresh);
		expect(merged?.tags).toEqual(fresh.tags);
		// Cache bookkeeping survives the merge.
		expect(merged?.ref).toBe('n1');
		expect(merged?.tile).toBe('10/1/1');
	});

	it('takes the live position of a moved node', () => {
		const merged = mergeFreshElement(cachedNode, { ...cachedNode, lat: 48.2, lon: 15.3 });
		expect(merged).toMatchObject({ lat: 48.2, lon: 15.3, tags: cachedNode.tags });
	});

	it('keeps an area’s center and outline, updating only its tags', () => {
		const outline = { type: 'Point', coordinates: [15, 48] } as GeoJSON.Geometry;
		const cachedArea = {
			id: 7,
			type: 'way',
			center: { lat: 48, lon: 15 },
			outline,
			tags: { emergency: 'fire_water_pond', natural: 'water' }
		};
		const fresh = {
			id: 7,
			type: 'way',
			center: { lat: 48.0001, lon: 15.0001 },
			tags: { emergency: 'fire_water_pond', natural: 'water', water_volume: '500' }
		};
		const merged = mergeFreshElement(cachedArea, fresh);
		expect(merged?.tags).toEqual(fresh.tags);
		expect(merged?.center).toEqual(cachedArea.center);
		expect(merged?.outline).toBe(outline);
		// A center that only differs by the live bounding-box estimate is no change.
		expect(mergeFreshElement(cachedArea, { ...fresh, tags: cachedArea.tags })).toBeNull();
	});
});
