/**
 * Fetches the routing test fixtures (Protomaps z15 vector tiles and Mapterhorn
 * DEM tiles) listed in every `scene.json` under
 * src/mapHandler/__fixtures__/routing/.
 *
 *   VITE_PROTOMAPS_API_KEY=<key> node scripts/fetch-routing-fixtures.mjs [--scene <id>]
 *
 * The Protomaps key is read from the environment only and is never written to a
 * file or printed. Mapterhorn needs no key. Behind a proxy that Node does not
 * pick up on its own, add `NODE_USE_ENV_PROXY=1` (and `NODE_EXTRA_CA_CERTS`).
 *
 * See src/mapHandler/__fixtures__/routing/README.md.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'mapHandler',
	'__fixtures__',
	'routing'
);

const key = process.env.VITE_PROTOMAPS_API_KEY;
if (!key) {
	console.error('VITE_PROTOMAPS_API_KEY is not set (pass it through the environment only).');
	process.exit(1);
}

const sceneArg = process.argv.indexOf('--scene');
const onlyScene = sceneArg > -1 ? process.argv[sceneArg + 1] : null;

/** Every tile of an `{ z, x: [min, max], y: [min, max] }` range. */
function* tilesOf({ z, x, y }) {
	for (let tx = x[0]; tx <= x[1]; tx++)
		for (let ty = y[0]; ty <= y[1]; ty++) yield { z, x: tx, y: ty };
}

/** Downloads `url` to `file`; returns the byte count. The URL is never logged (it may carry the key). */
async function download(url, file, label) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, bytes);
	return bytes.length;
}

const sceneDirs = (await readdir(ROOT, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory() && (!onlyScene || entry.name === onlyScene))
	.map((entry) => entry.name)
	.sort();
if (sceneDirs.length === 0) {
	console.error(`No scene found${onlyScene ? ` named ${onlyScene}` : ''} in ${ROOT}`);
	process.exit(1);
}

let grandTotal = 0;
for (const id of sceneDirs) {
	const scene = JSON.parse(await readFile(join(ROOT, id, 'scene.json'), 'utf8'));
	let sceneTotal = 0;
	let count = 0;
	for (const t of tilesOf(scene.tiles.basemap)) {
		const url = `https://api.protomaps.com/tiles/v4/${t.z}/${t.x}/${t.y}.mvt?key=${key}`;
		const file = join(ROOT, id, 'basemap', String(t.z), String(t.x), `${t.y}.mvt`);
		sceneTotal += await download(url, file, `${id} basemap ${t.z}/${t.x}/${t.y}`);
		count++;
	}
	for (const range of scene.tiles.dem) {
		for (const t of tilesOf(range)) {
			const url = `https://tiles.mapterhorn.com/${t.z}/${t.x}/${t.y}.webp`;
			const file = join(ROOT, id, 'dem', String(t.z), String(t.x), `${t.y}.webp`);
			sceneTotal += await download(url, file, `${id} dem ${t.z}/${t.x}/${t.y}`);
			count++;
		}
	}
	grandTotal += sceneTotal;
	console.log(`${id}: ${count} tiles, ${(sceneTotal / 1024).toFixed(0)} kB`);
}
console.log(`total: ${(grandTotal / 1024 / 1024).toFixed(2)} MB`);
