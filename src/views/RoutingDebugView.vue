<template>
	<ion-page>
		<ion-header :translucent="true">
			<ion-toolbar>
				<ion-buttons slot="start">
					<ion-back-button default-href="/settings"></ion-back-button>
				</ion-buttons>
				<ion-title>Routing debug</ion-title>
			</ion-toolbar>
		</ion-header>
		<ion-content :fullscreen="true" :scroll-y="false">
			<div class="debug-layout">
				<div ref="mapElement" class="debug-map"></div>
				<aside class="debug-panel">
					<label>
						Scene
						<select v-model="sceneId" @change="onSceneChange">
							<option v-for="id in sceneIds" :key="id" :value="id">{{ id }}</option>
						</select>
					</label>
					<label>
						Preset
						<select v-model="presetKey" @change="applyPreset">
							<option v-for="p in presets" :key="p.key" :value="p.key">{{ p.label }}</option>
						</select>
					</label>
					<p class="hint">Drag the green (origin) and red (target) marker.</p>

					<table class="stats">
						<thead>
							<tr>
								<th>Mode</th>
								<th>Length</th>
								<th>Ratio</th>
								<th>On road</th>
								<th>Time</th>
								<th>Profile</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="m in MODES" :key="m.id">
								<td><span class="swatch" :style="{ background: m.color }"></span>{{ m.label }}</td>
								<template v-if="results[m.id]">
									<td>{{ formatMeters(results[m.id].meters) }}</td>
									<td>{{ results[m.id].ratio?.toFixed(2) ?? '-' }}</td>
									<td>{{ formatShare(results[m.id].onRoad) }}</td>
									<td>{{ results[m.id].ms.toFixed(0) }} ms</td>
									<td>{{ results[m.id].note }}</td>
								</template>
								<td v-else colspan="5">{{ busy ? '...' : 'no route' }}</td>
							</tr>
						</tbody>
					</table>
					<p class="hint">Straight line: {{ formatMeters(straightMeters) }}</p>

					<label class="check">
						<input v-model="showCost" type="checkbox" @change="updateCostOverlay" />
						Cost raster (red building, orange fringe, blue road)
					</label>

					<button :disabled="busy || !scene?.rings?.length" @click="runRings">
						Run ring simulation ({{ scene?.rings?.length ?? 0 }} positions)
					</button>
					<p v-if="ringProgress" class="hint">{{ ringProgress }}</p>
					<table v-if="ringRows.length" class="stats">
						<thead>
							<tr>
								<th>Mode</th>
								<th>Radius</th>
								<th>n</th>
								<th>Median</th>
								<th>Worst</th>
							</tr>
						</thead>
						<tbody>
							<template v-for="m in MODES" :key="m.id">
								<tr v-for="row in ringRows.filter((r) => r.mode === m.id)" :key="m.id + row.radius">
									<td>{{ m.label }}</td>
									<td>{{ row.radius }} m</td>
									<td>{{ row.count }}/{{ row.count + row.unrouted }}</td>
									<td>{{ row.median?.toFixed(2) ?? '-' }}</td>
									<td>{{ row.worst?.toFixed(2) ?? '-' }}</td>
								</tr>
							</template>
						</tbody>
					</table>
				</aside>
			</div>
		</ion-content>
	</ion-page>
</template>

<script setup lang="ts">
/**
 * Dev-only routing tuning view (`/debug/routing`; registered only when
 * `import.meta.env.DEV` or `VITE_ROUTING_DEBUG=1`, see router/index.ts). It
 * routes with the app's own pipeline, so tiles come from the live sources
 * (or the offline store); it does not read the fixture tiles. It is a tuning
 * aid, not the acceptance mechanism: acceptance is by the spec files.
 *
 * To add a routing mode, append an entry to `MODES`.
 */
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import {
	IonBackButton,
	IonButtons,
	IonContent,
	IonHeader,
	IonPage,
	IonTitle,
	IonToolbar
} from '@ionic/vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers as protomapsLayers } from '@protomaps/basemaps';
import { outdoorsFlavor } from '@/map/outdoorsFlavor';
import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import {
	computeNearbyDistances,
	getRoutedPath,
	invalidateRoutingContext,
	type RoutingOptions
} from '@/mapHandler/nearbyRouting';
import { getObstaclesForBounds } from '@/mapHandler/obstacleGeometry';
import { buildTerrainGrid } from '@/mapHandler/gridRouting';
import {
	costRaster,
	onRoadShare,
	pathLength,
	ratioTable,
	type RatioRow,
	type RingSample
} from '@/mapHandler/routingDebug';

/** The routing modes drawn and compared. Phase 3+ append `optimized` here. */
const MODES: { id: string; label: string; color: string; options: RoutingOptions }[] = [
	{ id: 'roads', label: 'Road graph', color: '#0050ff', options: { clampToRoads: true } },
	{ id: 'terrain', label: 'Terrain grid', color: '#d02020', options: { clampToRoads: false } }
];

/** Subset of a fixture `scene.json` this view reads (the fixtures themselves are test data). */
interface DebugScene {
	id: string;
	anchor: GeoPoint & { label: string };
	cases?: Record<string, { label: string; from: GeoPoint; to: GeoPoint }>;
	rings?: { radius: number; bearing: number; vehicle: GeoPoint }[];
}

interface ModeResult {
	meters: number;
	ratio: number | null;
	onRoad: number;
	ms: number;
	/** Steep metres, warnings, fallback and DEM zoom of the route. */
	note: string;
}

const sceneLoaders = import.meta.glob<DebugScene>(
	'/src/mapHandler/__fixtures__/routing/*/scene.json',
	{ import: 'default' }
);
const sceneIds = Object.keys(sceneLoaders)
	.map((path) => path.split('/').at(-2) as string)
	.sort();

const MARGIN_M = 150;

const mapElement = ref<HTMLElement | null>(null);
const sceneId = ref(sceneIds[0] ?? '');
const scene = shallowRef<DebugScene | null>(null);
const presetKey = ref('');
const presets = ref<{ key: string; label: string; from: GeoPoint; to: GeoPoint }[]>([]);
const results = ref<Record<string, ModeResult>>({});
const straightMeters = ref(0);
const busy = ref(false);
const showCost = ref(false);
const ringRows = ref<(RatioRow & { mode: string })[]>([]);
const ringProgress = ref('');

let map: maplibregl.Map | null = null;
let originMarker: maplibregl.Marker | null = null;
let targetMarker: maplibregl.Marker | null = null;
let runToken = 0;

const formatMeters = (m: number) =>
	m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
const formatShare = (s: number) => `${Math.round(s * 100)} %`;

function point(lngLat: maplibregl.LngLat): GeoPoint {
	return { lat: lngLat.lat, lng: lngLat.lng };
}

function boundsAround(points: GeoPoint[], marginM: number): GeoBounds {
	const lats = points.map((p) => p.lat);
	const lngs = points.map((p) => p.lng);
	const south = Math.min(...lats);
	const north = Math.max(...lats);
	const dLat = marginM / 110540;
	const dLng = marginM / (111320 * Math.cos((((south + north) / 2) * Math.PI) / 180));
	return {
		south: south - dLat,
		north: north + dLat,
		west: Math.min(...lngs) - dLng,
		east: Math.max(...lngs) + dLng
	};
}

function style(): maplibregl.StyleSpecification {
	return {
		version: 8,
		glyphs: 'offline://assets/fonts/{fontstack}/{range}.pbf',
		sprite: 'offline://assets/sprites/v4/light',
		sources: {
			protomaps: {
				type: 'vector',
				tiles: ['offline://protomaps/{z}/{x}/{y}'],
				minzoom: 0,
				maxzoom: 15
			}
		},
		layers: protomapsLayers('protomaps', outdoorsFlavor, { lang: 'en' })
	};
}

function makeMarker(color: string, lngLat: GeoPoint): maplibregl.Marker {
	const marker = new maplibregl.Marker({ color, draggable: true }).setLngLat([
		lngLat.lng,
		lngLat.lat
	]);
	marker.on('dragend', () => void recompute());
	return marker.addTo(map as maplibregl.Map);
}

function setRouteLine(id: string, color: string, path: GeoPoint[] | null): void {
	if (!map) return;
	const data: GeoJSON.Feature = {
		type: 'Feature',
		properties: {},
		geometry: {
			type: 'LineString',
			coordinates: (path ?? []).map((p) => [p.lng, p.lat])
		}
	};
	const source = map.getSource(`route-${id}`) as maplibregl.GeoJSONSource | undefined;
	if (source) {
		source.setData(data);
		return;
	}
	map.addSource(`route-${id}`, { type: 'geojson', data });
	map.addLayer({
		id: `route-${id}`,
		type: 'line',
		source: `route-${id}`,
		paint: { 'line-color': color, 'line-width': 4, 'line-opacity': 0.85 }
	});
}

async function recompute(): Promise<void> {
	if (!originMarker || !targetMarker) return;
	const token = ++runToken;
	const origin = point(originMarker.getLngLat());
	const target = point(targetMarker.getLngLat());
	straightMeters.value = distanceTo(origin, target);
	busy.value = true;
	invalidateRoutingContext();
	const roads = (await getObstaclesForBounds(boundsAround([origin, target], MARGIN_M))).roads;
	const next: Record<string, ModeResult> = {};
	for (const mode of MODES) {
		const t0 = performance.now();
		const route = await getRoutedPath(origin, target, mode.options);
		const ms = performance.now() - t0;
		const path = route.routed ? route.points : null;
		setRouteLine(mode.id, mode.color, path);
		if (path) {
			const meters = pathLength(path);
			next[mode.id] = {
				meters,
				ratio: straightMeters.value > 0 ? meters / straightMeters.value : null,
				onRoad: onRoadShare(path, roads),
				ms,
				note: [
					`>25%: ${route.metersOver25.toFixed(0)} m`,
					`>50%: ${route.metersOver50.toFixed(0)} m`,
					route.climbM === null
						? 'no DEM'
						: `climb ${route.climbM.toFixed(0)} m (z${route.demZoom})`,
					route.notRecommended ? 'NOT RECOMMENDED' : '',
					route.fallback ?? ''
				]
					.filter(Boolean)
					.join(', ')
			};
		}
	}
	if (token !== runToken) return;
	results.value = next;
	busy.value = false;
	await updateCostOverlay();
}

async function updateCostOverlay(): Promise<void> {
	if (!map || !originMarker || !targetMarker) return;
	if (map.getLayer('cost')) map.removeLayer('cost');
	if (map.getSource('cost')) map.removeSource('cost');
	if (!showCost.value) return;
	const bounds = boundsAround(
		[point(originMarker.getLngLat()), point(targetMarker.getLngLat())],
		MARGIN_M
	);
	const grid = buildTerrainGrid(await getObstaclesForBounds(bounds), bounds);
	if (!grid) return;
	const raster = costRaster(grid);
	const canvas = document.createElement('canvas');
	canvas.width = raster.width;
	canvas.height = raster.height;
	canvas
		.getContext('2d')
		?.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);
	map.addSource('cost', {
		type: 'image',
		url: canvas.toDataURL(),
		coordinates: [
			[bounds.west, bounds.north],
			[bounds.east, bounds.north],
			[bounds.east, bounds.south],
			[bounds.west, bounds.south]
		]
	});
	map.addLayer({
		id: 'cost',
		type: 'raster',
		source: 'cost',
		paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' }
	});
}

function applyPreset(): void {
	const preset = presets.value.find((p) => p.key === presetKey.value);
	if (!preset || !map) return;
	originMarker?.setLngLat([preset.from.lng, preset.from.lat]);
	targetMarker?.setLngLat([preset.to.lng, preset.to.lat]);
	map.fitBounds(
		[
			[Math.min(preset.from.lng, preset.to.lng), Math.min(preset.from.lat, preset.to.lat)],
			[Math.max(preset.from.lng, preset.to.lng), Math.max(preset.from.lat, preset.to.lat)]
		],
		{ padding: 80, animate: false }
	);
	void recompute();
}

async function onSceneChange(): Promise<void> {
	const loader = sceneLoaders[`/src/mapHandler/__fixtures__/routing/${sceneId.value}/scene.json`];
	if (!loader) return;
	const loaded = await loader();
	scene.value = loaded;
	ringRows.value = [];
	ringProgress.value = '';
	const list: typeof presets.value = [];
	for (const [key, c] of Object.entries(loaded.cases ?? {})) {
		list.push({
			key: `case:${key}`,
			label: `${key}: ${c.label.slice(0, 60)}`,
			from: c.from,
			to: c.to
		});
	}
	for (const [i, ring] of (loaded.rings ?? []).entries()) {
		list.push({
			key: `ring:${i}`,
			label: `ring ${ring.radius} m / ${ring.bearing} deg -> anchor`,
			from: ring.vehicle,
			to: loaded.anchor
		});
	}
	if (list.length === 0) {
		list.push({
			key: 'anchor',
			label: `${loaded.anchor.label}`,
			from: loaded.anchor,
			to: loaded.anchor
		});
	}
	presets.value = list;
	presetKey.value = list[0].key;
	if (map && !originMarker) {
		originMarker = makeMarker('#1a9a3a', list[0].from);
		targetMarker = makeMarker('#d02020', list[0].to);
	}
	applyPreset();
}

/** Runs every ring position through every mode and prints median/worst ratio per radius. */
async function runRings(): Promise<void> {
	const rings = scene.value?.rings;
	if (!rings || !scene.value) return;
	busy.value = true;
	const anchor = scene.value.anchor;
	const rows: (RatioRow & { mode: string })[] = [];
	for (const mode of MODES) {
		const samples: RingSample[] = [];
		for (const [i, ring] of rings.entries()) {
			ringProgress.value = `${mode.label}: ${i + 1}/${rings.length}`;
			invalidateRoutingContext();
			const straight = distanceTo(ring.vehicle, anchor);
			const [result] = await computeNearbyDistances(
				ring.vehicle,
				[anchor],
				[straight],
				mode.options
			);
			samples.push({
				radius: ring.radius,
				ratio: result.routedDistance === null ? null : result.routedDistance / straight
			});
		}
		rows.push(...ratioTable(samples).map((row) => ({ ...row, mode: mode.id })));
	}
	ringRows.value = rows;
	ringProgress.value = 'Done';
	busy.value = false;
}

onMounted(async () => {
	if (!mapElement.value) return;
	map = new maplibregl.Map({
		container: mapElement.value,
		style: style(),
		center: [15.27, 48.13],
		zoom: 14,
		maxZoom: 19
	});
	map.on('load', () => {
		map?.resize();
		void onSceneChange();
	});
});

onUnmounted(() => {
	map?.remove();
	map = null;
});
</script>

<style scoped>
.debug-layout {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
}
.debug-map {
	flex: 1 1 55%;
	min-height: 240px;
}
.debug-panel {
	flex: 1 1 45%;
	overflow: auto;
	padding: 8px 16px 16px;
	font-size: 13px;
	background: var(--ion-background-color);
	color: var(--ion-text-color);
}
.debug-panel label {
	display: block;
	margin: 6px 0;
}
.debug-panel select {
	width: 100%;
	margin-top: 2px;
}
.debug-panel button {
	margin: 8px 0;
	padding: 6px 12px;
}
.hint {
	margin: 4px 0;
	opacity: 0.7;
}
.stats {
	width: 100%;
	border-collapse: collapse;
	margin: 8px 0;
}
.stats th,
.stats td {
	text-align: left;
	padding: 2px 6px 2px 0;
}
.swatch {
	display: inline-block;
	width: 10px;
	height: 10px;
	margin-right: 6px;
	border-radius: 2px;
}
@media (min-width: 900px) {
	.debug-layout {
		flex-direction: row;
	}
	.debug-map {
		flex: 1 1 65%;
	}
	.debug-panel {
		flex: 0 0 380px;
	}
}
</style>
