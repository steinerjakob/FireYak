import { describe, expect, it } from 'vitest';
import { CellHeap } from '@/mapHandler/cellHeap';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('CellHeap', () => {
	it('10,000 seeded random pushes pop in non-decreasing order', () => {
		const next = rng(42);
		const heap = new CellHeap(16);
		const pushed: number[] = [];
		for (let i = 0; i < 10_000; i++) {
			const key = Math.floor(next() * 1e6) / 10;
			pushed.push(key);
			heap.push(key, i);
		}
		const popped: number[] = [];
		while (heap.size > 0) {
			const cell = heap.pop();
			expect(cell).toBeGreaterThanOrEqual(0);
			popped.push(heap.lastKey);
		}
		expect(popped).toHaveLength(10_000);
		for (let i = 1; i < popped.length; i++) expect(popped[i]).toBeGreaterThanOrEqual(popped[i - 1]);
		expect(popped).toEqual([...pushed].sort((a, b) => a - b));
	});

	it('keeps each cell with its key while interleaving pushes and pops', () => {
		const next = rng(7);
		const heap = new CellHeap(4);
		const keyOf = new Map<number, number>();
		let last = -Infinity;
		for (let i = 0; i < 2000; i++) {
			const key = last + next() * 100;
			keyOf.set(i, key);
			heap.push(key, i);
			if (i % 3 === 0) {
				const cell = heap.pop();
				expect(heap.lastKey).toBe(keyOf.get(cell));
				expect(heap.lastKey).toBeGreaterThanOrEqual(last);
				last = heap.lastKey;
			}
		}
	});

	it('grows past its initial capacity', () => {
		const heap = new CellHeap(2);
		for (let i = 0; i < 100; i++) heap.push(100 - i, i);
		expect(heap.size).toBe(100);
		expect(heap.capacity).toBeGreaterThanOrEqual(100);
		expect(heap.pop()).toBe(99);
		expect(heap.lastKey).toBe(1);
	});

	it('handles equal keys (every entry comes out once)', () => {
		const heap = new CellHeap(8);
		for (let i = 0; i < 50; i++) heap.push(5, i);
		heap.push(1, 1000);
		expect(heap.pop()).toBe(1000);
		const cells = new Set<number>();
		while (heap.size > 0) {
			cells.add(heap.pop());
			expect(heap.lastKey).toBe(5);
		}
		expect(cells.size).toBe(50);
	});

	it('returns -1 and an infinite peek when empty', () => {
		const heap = new CellHeap();
		expect(heap.pop()).toBe(-1);
		expect(heap.peekKey()).toBe(Infinity);
		heap.push(3, 9);
		expect(heap.peekKey()).toBe(3);
	});
});
