import { PbfWriter } from 'pbf';

/**
 * Minimal Mapbox Vector Tile encoder for synthetic test tiles (test-only).
 * Geometry is given in tile coordinates (0..extent, y down).
 */

export interface MvtFeature {
	/** 1 = point, 2 = line, 3 = polygon. */
	type: 1 | 2 | 3;
	/** Rings or lines; polygon rings are closed implicitly. */
	geometry: [number, number][][];
	properties?: Record<string, string>;
}

export interface MvtLayer {
	name: string;
	features: MvtFeature[];
	extent?: number;
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

function commands(feature: MvtFeature): number[] {
	const out: number[] = [];
	let cx = 0;
	let cy = 0;
	for (const part of feature.geometry) {
		const points = feature.type === 3 ? part.slice(0, -1) : part;
		const [first, ...rest] = points;
		out.push((1 << 3) | 1, zigzag(first[0] - cx), zigzag(first[1] - cy));
		cx = first[0];
		cy = first[1];
		if (rest.length > 0) {
			out.push((rest.length << 3) | 2);
			for (const [x, y] of rest) {
				out.push(zigzag(x - cx), zigzag(y - cy));
				cx = x;
				cy = y;
			}
		}
		if (feature.type === 3) out.push((1 << 3) | 7);
	}
	return out;
}

/** Encodes the layers into tile bytes. */
export function encodeMvt(layers: MvtLayer[]): ArrayBuffer {
	const pbf = new PbfWriter();
	for (const layer of layers) {
		pbf.writeMessage(
			3,
			(l: MvtLayer, w: PbfWriter) => {
				const keys: string[] = [];
				const values: string[] = [];
				w.writeVarintField(15, 2);
				w.writeStringField(1, l.name);
				for (const feature of l.features) {
					const tags: number[] = [];
					for (const [key, value] of Object.entries(feature.properties ?? {})) {
						let k = keys.indexOf(key);
						if (k === -1) k = keys.push(key) - 1;
						let v = values.indexOf(value);
						if (v === -1) v = values.push(value) - 1;
						tags.push(k, v);
					}
					w.writeMessage(
						2,
						(f: MvtFeature, fw: PbfWriter) => {
							fw.writePackedVarint(2, tags);
							fw.writeVarintField(3, f.type);
							fw.writePackedVarint(4, commands(f));
						},
						feature
					);
				}
				for (const key of keys) w.writeStringField(3, key);
				for (const value of values) {
					w.writeMessage(4, (val: string, vw: PbfWriter) => vw.writeStringField(1, val), value);
				}
				w.writeVarintField(5, l.extent ?? 4096);
			},
			layer
		);
	}
	const bytes = pbf.finish();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
