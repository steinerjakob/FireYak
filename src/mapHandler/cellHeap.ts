/**
 * Binary min-heap over (key, cell) pairs on typed arrays (plan §6.5):
 * `Float64Array` keys, `Int32Array` cells, grown by doubling. Duplicates are
 * allowed (lazy deletion: callers skip cells they already settled).
 *
 * The sift rules (stop sifting up at an equal parent, sift down to the
 * strictly smaller child, left first) match the array heap the terrain grid
 * used before, so equal keys pop in the same order and routes do not change.
 *
 * Pure module: safe in a worker.
 */
export class CellHeap {
	private keys: Float64Array;
	private cells: Int32Array;
	private count = 0;

	constructor(initialCapacity = 1024) {
		const capacity = Math.max(1, initialCapacity);
		this.keys = new Float64Array(capacity);
		this.cells = new Int32Array(capacity);
	}

	get size(): number {
		return this.count;
	}

	/** Current storage capacity (grows by doubling). */
	get capacity(): number {
		return this.keys.length;
	}

	push(key: number, cell: number): void {
		if (this.count === this.keys.length) this.grow();
		const keys = this.keys;
		const cells = this.cells;
		let i = this.count++;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (keys[parent] <= key) break;
			keys[i] = keys[parent];
			cells[i] = cells[parent];
			i = parent;
		}
		keys[i] = key;
		cells[i] = cell;
	}

	/** Key of the smallest entry (`Infinity` when empty). */
	peekKey(): number {
		return this.count > 0 ? this.keys[0] : Infinity;
	}

	/**
	 * Removes the smallest entry and returns its cell, or `-1` when empty. Its
	 * key is in {@link lastKey} afterwards.
	 */
	pop(): number {
		if (this.count === 0) return -1;
		const keys = this.keys;
		const cells = this.cells;
		const topCell = cells[0];
		this.lastKey = keys[0];
		const n = --this.count;
		if (n > 0) {
			const key = keys[n];
			const cell = cells[n];
			let i = 0;
			for (;;) {
				const left = 2 * i + 1;
				const right = left + 1;
				let smallest = i;
				let smallestKey = key;
				if (left < n && keys[left] < smallestKey) {
					smallest = left;
					smallestKey = keys[left];
				}
				if (right < n && keys[right] < smallestKey) smallest = right;
				if (smallest === i) break;
				keys[i] = keys[smallest];
				cells[i] = cells[smallest];
				i = smallest;
			}
			keys[i] = key;
			cells[i] = cell;
		}
		return topCell;
	}

	/** Key of the entry the last {@link pop} returned. */
	lastKey = Infinity;

	private grow(): void {
		const keys = new Float64Array(this.keys.length * 2);
		keys.set(this.keys);
		const cells = new Int32Array(this.cells.length * 2);
		cells.set(this.cells);
		this.keys = keys;
		this.cells = cells;
	}
}
