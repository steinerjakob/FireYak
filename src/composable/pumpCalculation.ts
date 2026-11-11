import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import maplibregl from 'maplibre-gl';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import wayPointIcon from '@/assets/markers/waypoint.png';
import { resamplePolyline } from '@/helper/distanceCalculation';
import { ElevationPoint, getElevationDataForPoints } from '@/helper/elevationData';
import { getPumpLocationMarkers, PumpPosition } from '@/helper/calculatePumpPosition';
import { useI18n } from 'vue-i18n';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import { useSettingsStore } from '@/store/settingsStore';
import { useDefaultStore } from '@/store/defaultStore';
import { getRoutedPath, type HoseRoute, type RouteFallback } from '@/mapHandler/nearbyRouting';
import { getMapNodeById } from '@/mapHandler/databaseHandler';
import { accessTargetPoint, isPondArea, resolveAccessPoint } from '@/mapHandler/waterSourceAccess';
import { addRouteLayers, routeRunFeatures } from '@/mapHandler/routeLayers';
import { slopeNotRecommended, type RouteSegment } from '@/helper/routeProfile';
import {
	evaluateDownhillPressure,
	parseHydrantPressure,
	stretchesAlongLine,
	type PressureLevel
} from '@/helper/hosePressure';
import type { OverPassElement } from '@/mapHandler/overPassApi';
import { alertController } from '@ionic/vue';
import { GeoPoint, distanceTo } from '@/types/geo';
import { OsmRef } from '@/helper/osmRef';

const PUMP_LINE_SOURCE = 'pump-line';
/** Route runs (on-road, off-road dashed, steep ticks) share this prefix. */
const PUMP_LINE_LAYER_PREFIX = 'pump-line';
const PUMP_LINE_LABEL_LAYER = 'pump-line-label-layer';

let rootMap: maplibregl.Map | null = null;
let suctionPoint: maplibregl.Marker | null = null;
let targetPoint: maplibregl.Marker | null = null;
const wayPoints: maplibregl.Marker[] = [];
const pumpMarkers: maplibregl.Marker[] = [];
/**
 * Pond area the suction point was taken from (issue #110). While set, the
 * suction point follows the fire point: it sits on the pond's shore nearest to
 * it (or on a mapped suction point at the pond). Cleared as soon as the user
 * places or drags the suction point themselves.
 */
let pondSource: OverPassElement | null = null;
let pondSnapToken = 0;

export interface CalculationResult {
	/** Length of the drawn line in metres; pump distances are along it. */
	realDistance: number;
	elevation: number;
	wayPoints: maplibregl.Marker[];
	suctionPoint: maplibregl.Marker;
	targetPoint: maplibregl.Marker;
	pumpCount: number;
	elevationData: ElevationPoint[];
	pumpPositions: PumpPosition[];
	/** True when elevation was ignored (offline flat-terrain fallback) for this result. */
	elevationIgnored: boolean;
	/** Hydrant pressure (bar) feeding the line, or `null` = pump at the source. */
	sourcePressure: number | null;
	/** Length of the drawn line in metres (2D): the same number the map label shows. */
	lineMeters: number;
	/** Steep-run and pressure warnings for the drawn line. */
	warnings: PumpLineWarnings;
}

/** Warnings of the pump line (plan §6.8, §6.13). */
export interface PumpLineWarnings {
	notRecommended: boolean;
	pressureLevel: PressureLevel | null;
	staticPressureMaxBar: number | null;
	/** Fallback reasons of the line's legs, without duplicates. */
	fallbacks: RouteFallback[];
	/** True when some leg had only part of the map data. */
	incomplete: boolean;
}

const calculationResult = ref<CalculationResult | null>(null);

/**
 * Entry of the result panel a tapped map marker / list row / chart point
 * refers to: `'suction'`, `'target'` or `'pump-<index into pumpPositions>'`.
 */
export type ResultEntryId = 'suction' | 'target' | `pump-${number}`;

const selectedResultEntry = ref<ResultEntryId | null>(null);

/** CSS class (global, see SupplyPipeCalculation.vue) marking the selected marker. */
const SELECTED_MARKER_CLASS = 'pump-result-selected-marker';

function resultEntryMarkers(): [ResultEntryId, maplibregl.Marker | null][] {
	return [
		['suction', suctionPoint],
		['target', targetPoint],
		...pumpMarkers.map((m, i) => [`pump-${i}`, m] as [ResultEntryId, maplibregl.Marker])
	];
}

function applyEntryHighlight() {
	for (const [id, marker] of resultEntryMarkers()) {
		const el = marker?.getElement();
		if (!el) continue;
		const isSelected = id === selectedResultEntry.value;
		el.classList.toggle(SELECTED_MARKER_CLASS, isSelected);
		// Lift the selected marker above overlapping neighbors.
		el.style.zIndex = isSelected ? '2' : '';
	}
}

watch(selectedResultEntry, applyEntryHighlight);
// Leaving the result view (back button / route change) drops the selection.
watch(calculationResult, (result) => {
	if (!result) selectedResultEntry.value = null;
});

/**
 * Pans the map so the marker sits centered in the map area not covered by the
 * result sheet (mobile) or the side panel (desktop) — same offset logic as
 * MainMap's fit-to-marker.
 */
function centerOnMarker(marker: maplibregl.Marker) {
	if (!rootMap) return;
	const view = useDefaultStore().visibleMapView;
	const offsetX = view.x / 2;
	const offsetY = (view.top - (view.yMax - view.y)) / 2;
	const point = rootMap.project(marker.getLngLat());
	const adjusted = rootMap.unproject(new maplibregl.Point(point.x - offsetX, point.y - offsetY));
	rootMap.panTo(adjusted);
}

/**
 * Selects a result entry (panel row, chart point and map marker stay in
 * sync). `center` pans the map to the marker — used when the selection comes
 * from the panel; taps on the marker itself skip it.
 */
function selectResultEntry(id: ResultEntryId | null, options: { center?: boolean } = {}) {
	selectedResultEntry.value = id;
	if (!id || !options.center) return;
	const marker = resultEntryMarkers().find(([entryId]) => entryId === id)?.[1];
	if (marker) centerOnMarker(marker);
}

function setMap(map: maplibregl.Map) {
	rootMap = map;
	// Add pump line source/layer if not present
	if (!map.getSource(PUMP_LINE_SOURCE)) {
		map.addSource(PUMP_LINE_SOURCE, {
			type: 'geojson',
			// Holds the hose line plus one labeled midpoint per pump-to-pump segment.
			data: { type: 'FeatureCollection', features: [] }
		});
		addRouteLayers(map, PUMP_LINE_SOURCE, PUMP_LINE_LAYER_PREFIX);
		// Hose-count label per segment, anchored to point symbols like the
		// nearby-marker path label (line-center placement drops labels on
		// short/bent lines).
		map.addLayer({
			id: PUMP_LINE_LABEL_LAYER,
			type: 'symbol',
			source: PUMP_LINE_SOURCE,
			filter: ['==', ['geometry-type'], 'Point'],
			layout: {
				'text-field': ['get', 'label'],
				'text-font': ['Noto Sans Medium'],
				'text-size': 13,
				'text-offset': [0, -0.9],
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: {
				'text-color': '#3388ff',
				'text-halo-color': '#ffffff',
				'text-halo-width': 2
			}
		});
	}
}

const suctionPointSet = ref(false);
const firePointSet = ref(false);

function getMarkerLngLat(marker: maplibregl.Marker): GeoPoint {
	const lngLat = marker.getLngLat();
	return { lat: lngLat.lat, lng: lngLat.lng };
}

const sortWaypoints = (): void => {
	if (!suctionPoint || wayPoints.length < 2) {
		// No need to sort if there are 0 or 1 waypoints
		return;
	}

	let lastPoint = suctionPoint;
	const remainingWaypoints = [...wayPoints];
	const sortedWaypoints: maplibregl.Marker[] = [];

	while (remainingWaypoints.length > 0) {
		let closestIndex = -1;
		let minDistance = Infinity;

		remainingWaypoints.forEach((point, index) => {
			const dist = distanceTo(getMarkerLngLat(lastPoint), getMarkerLngLat(point));
			if (dist < minDistance) {
				minDistance = dist;
				closestIndex = index;
			}
		});

		const [closestPoint] = remainingWaypoints.splice(closestIndex, 1);
		sortedWaypoints.push(closestPoint);
		lastPoint = closestPoint;
	}

	wayPoints.splice(0, wayPoints.length, ...sortedWaypoints);
};

/** Marker chain suction point → waypoints → fire object as GeoPoints. */
function markerChain(): GeoPoint[] {
	return [suctionPoint!, ...wayPoints, targetPoint!].map(getMarkerLngLat);
}

/**
 * The hose line geometry as last drawn: the routed path when routing
 * succeeded, otherwise `null` (straight marker chain shown). The calculation
 * uses this so distances/pump positions match the displayed line.
 */
let routedPathPoints: GeoPoint[] | null = null;
/** The routed legs of the drawn line (profile, runs, fallbacks), or `null`. */
let routedLegs: HoseRoute[] | null = null;
/** Runs of the drawn line in metres along it (legs joined). */
let lineSegments: RouteSegment[] = [];
/** Resolves when the latest routing attempt has been drawn (or superseded). */
let routingPromise: Promise<void> | null = null;
let routingToken = 0;

/** Per-segment hose-count labels (between suction point, pumps and target). */
let segmentLabels: { point: GeoPoint; label: string }[] = [];

/** Point `targetDist` meters along the polyline (clamped to its end). */
function pointAlongPath(path: GeoPoint[], targetDist: number): GeoPoint {
	let walked = 0;
	for (let i = 0; i < path.length - 1; i++) {
		const segLen = distanceTo(path[i], path[i + 1]);
		if (segLen > 0 && walked + segLen >= targetDist) {
			const f = (targetDist - walked) / segLen;
			return {
				lat: path[i].lat + (path[i + 1].lat - path[i].lat) * f,
				lng: path[i].lng + (path[i + 1].lng - path[i].lng) * f
			};
		}
		walked += segLen;
	}
	return path[path.length - 1];
}

function pumpLineFeatures(points: GeoPoint[]): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [
		...routeRunFeatures(points, points === routedPathPoints ? lineSegments : [])
	];
	for (const { point, label } of segmentLabels) {
		features.push({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
			properties: { label }
		});
	}
	return { type: 'FeatureCollection', features };
}

function setPumpLineGeometry(points: GeoPoint[]) {
	if (!rootMap) return;
	const source = rootMap.getSource(PUMP_LINE_SOURCE) as maplibregl.GeoJSONSource;
	if (source) {
		source.setData(pumpLineFeatures(points));
	}
}

/**
 * Routes each leg of the marker chain like the nearby-marker path does
 * (terrain or road routing per the clamp-to-roads setting), falling back to
 * the straight segment for unroutable/too-long legs. Legs run sequentially so
 * they reuse the cached routing context instead of racing to rebuild it.
 */
async function updateRoutedPolyline(chain: GeoPoint[]): Promise<void> {
	const token = ++routingToken;
	const settingsStore = useSettingsStore();
	const legs: HoseRoute[] = [];
	for (let i = 0; i < chain.length - 1; i++) {
		// The pressure rule needs the pump positions, so it runs after the
		// calculation over the joined profile (see calculatePumpRequirements).
		legs.push(
			await getRoutedPath(chain[i], chain[i + 1], {
				mode: settingsStore.hoseRouting,
				compareRoads: false
			})
		);
	}
	if (token !== routingToken) return; // markers moved meanwhile — superseded

	const path: GeoPoint[] = [chain[0]];
	const segments: RouteSegment[] = [];
	let offset = 0;
	for (const leg of legs) {
		path.push(...leg.points.slice(1));
		for (const run of leg.segments) {
			segments.push({ ...run, from: run.from + offset, to: run.to + offset });
		}
		offset += leg.planMeters;
	}
	routedLegs = legs;
	lineSegments = segments;
	routedPathPoints = path;
	setPumpLineGeometry(path);
}

/**
 * Bound to the latest `calculatePumpRequirements` closure (it needs the
 * component-scoped i18n `t` for segment labels) so module-level geometry
 * handlers can re-run the calculation.
 */
let recalculate: (() => Promise<void>) | null = null;

let autoRecalcTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-runs the calculation after the line geometry changed while a result is
 * showing (marker dragged, waypoint added/removed). Debounced so rapid
 * successive edits collapse into one recalculation; the calculation itself
 * awaits `routingPromise`, so it always uses the re-routed geometry.
 */
function scheduleAutoRecalc() {
	if (!calculationResult.value || !recalculate) return;
	if (autoRecalcTimer) clearTimeout(autoRecalcTimer);
	autoRecalcTimer = setTimeout(() => {
		autoRecalcTimer = null;
		recalculate?.();
	}, 400);
}

const updatePolyline = (options: { autoRecalc?: boolean } = {}) => {
	if (!suctionPoint || !targetPoint || !rootMap) {
		return;
	}
	sortWaypoints();
	const chain = markerChain();

	// Draw the straight chain immediately (responsive while dragging), then
	// swap in the routed geometry once it resolves. Moving markers invalidates
	// the calculated segment labels.
	routedPathPoints = null;
	routedLegs = null;
	lineSegments = [];
	segmentLabels = [];
	setPumpLineGeometry(chain);
	routingPromise = updateRoutedPolyline(chain).catch((e) => {
		console.warn('Pump line routing failed, keeping straight line:', e);
	});
	if (options.autoRecalc !== false) {
		scheduleAutoRecalc();
	}
};

function createMarkerElement(iconUrl: string, size: [number, number]): HTMLImageElement {
	const el = document.createElement('img');
	el.src = iconUrl;
	el.style.width = `${size[0]}px`;
	el.style.height = `${size[1]}px`;
	return el;
}

const getMarkerConfig = (type: 'firePoint' | 'suctionPoint' | 'wayPoint') => {
	let iconUrl = suctionPointIcon;
	let size: [number, number] = [48, 48];
	let anchor: 'center' | 'top' | 'bottom' | 'left' | 'right' = 'bottom';

	if (type === 'firePoint') {
		iconUrl = firepointIcon;
	} else if (type === 'wayPoint') {
		iconUrl = wayPointIcon;
		size = [32, 32];
		anchor = 'center';
	}

	return { iconUrl, size, anchor };
};

function getPolylineBounds(): maplibregl.LngLatBounds | null {
	if (!suctionPoint || !targetPoint) return null;
	const bounds = new maplibregl.LngLatBounds();
	const allPoints = [suctionPoint, ...wayPoints, targetPoint, ...pumpMarkers];
	allPoints.forEach((m) => bounds.extend(m.getLngLat()));
	// The routed line can bulge beyond the marker bounding box.
	routedPathPoints?.forEach((p) => bounds.extend([p.lng, p.lat]));
	return bounds;
}

function hasPolyline(): boolean {
	return Boolean(suctionPoint && targetPoint);
}

/**
 * The suction point for a pond target: a mapped suction point as is; for a
 * shore, the shore point the hose route from the fire point reaches (routing
 * picks it, plan §6.5), else the straight-line nearest one.
 */
async function suctionPointOnShore(
	target: Awaited<ReturnType<typeof resolveAccessPoint>> & object,
	firePoint: GeoPoint
): Promise<GeoPoint> {
	if (target.kind === 'point') return target.point;
	const route = await getRoutedPath(firePoint, target, {
		mode: useSettingsStore().hoseRouting,
		profile: false,
		compareRoads: false
	});
	return route.routed ? route.points[route.points.length - 1] : accessTargetPoint(target);
}

/**
 * Moves a pond-sourced suction point to the shore point the route from the
 * fire point reaches. No-op unless the suction point came from a pond area.
 */
async function snapPondSuctionToFirePoint(): Promise<void> {
	if (!pondSource || !suctionPoint || !targetPoint) return;
	const token = ++pondSnapToken;
	const source = pondSource;
	const target = await resolveAccessPoint(source, getMarkerLngLat(targetPoint), {
		// A late pond outline moves the suction point once more.
		onOutlineArrived: () => {
			if (token === pondSnapToken) void snapPondSuctionToFirePoint();
		}
	});
	// Superseded, torn down, or the user took over the suction point meanwhile.
	if (token !== pondSnapToken || pondSource !== source || !suctionPoint || !target) return;
	const access = await suctionPointOnShore(target, getMarkerLngLat(targetPoint));
	if (token !== pondSnapToken || pondSource !== source || !suctionPoint) return;
	const current = getMarkerLngLat(suctionPoint);
	if (current.lat === access.lat && current.lng === access.lng) return;
	suctionPoint.setLngLat([access.lng, access.lat]);
	updatePolyline();
}

const setTargetPoint = (latlng?: GeoPoint) => {
	const point =
		latlng || (rootMap ? { lat: rootMap.getCenter().lat, lng: rootMap.getCenter().lng } : null);
	if (!point || !rootMap) return;

	if (!targetPoint) {
		const { iconUrl, size, anchor } = getMarkerConfig('firePoint');
		targetPoint = new maplibregl.Marker({
			element: createMarkerElement(iconUrl, size),
			anchor,
			draggable: true
		});
		targetPoint.setLngLat([point.lng, point.lat]).addTo(rootMap);
		targetPoint.getElement().addEventListener('click', () => {
			if (calculationResult.value) selectResultEntry('target');
		});
	} else {
		targetPoint.setLngLat([point.lng, point.lat]);
	}

	targetPoint.on('dragend', () => {
		updatePolyline();
		void snapPondSuctionToFirePoint();
	});

	firePointSet.value = true;
	updatePolyline();
	void snapPondSuctionToFirePoint();
};

const removeWayPoint = (wayPointToRemove: maplibregl.Marker) => {
	const index = wayPoints.indexOf(wayPointToRemove);
	if (index > -1) {
		wayPoints.splice(index, 1);
		wayPointToRemove.remove();
		updatePolyline();
	}
};

function restoreMapState(map: maplibregl.Map) {
	// Re-add suction point marker
	if (suctionPoint) {
		suctionPoint.addTo(map);
	}
	// Re-add target point marker
	if (targetPoint) {
		targetPoint.addTo(map);
	}
	// Re-add waypoint markers
	wayPoints.forEach((wp) => wp.addTo(map));
	// Re-add pump position markers
	pumpMarkers.forEach((pm) => pm.addTo(map));
	// Restore polyline data — the geometry didn't change (map style switch),
	// so don't trigger a recalculation that would drop the user's selection.
	updatePolyline({ autoRecalc: false });
}

const setWayPoint = (latlng?: GeoPoint) => {
	const point =
		latlng || (rootMap ? { lat: rootMap.getCenter().lat, lng: rootMap.getCenter().lng } : null);
	if (!point || !rootMap) return;

	const { iconUrl, size, anchor } = getMarkerConfig('wayPoint');
	const wayPoint = new maplibregl.Marker({
		element: createMarkerElement(iconUrl, size),
		anchor,
		draggable: true
	});
	wayPoint.setLngLat([point.lng, point.lat]).addTo(rootMap);

	wayPoint.on('dragend', () => {
		updatePolyline();
	});

	const popup = new maplibregl.Popup({ offset: 12 });
	const popupContent = document.createElement('div');
	popupContent.style.textAlign = 'center';
	const removeButton = document.createElement('button');
	removeButton.textContent = '\u{1F5D1}'; // 🗑
	removeButton.style.color = 'red';
	removeButton.style.backgroundColor = 'transparent';
	removeButton.style.border = 'none';
	removeButton.style.cursor = 'pointer';
	removeButton.style.fontSize = '2em';
	removeButton.style.padding = '0';
	removeButton.onclick = () => removeWayPoint(wayPoint);
	popupContent.appendChild(removeButton);

	popup.setDOMContent(popupContent);
	wayPoint.setPopup(popup);

	wayPoints.push(wayPoint);
	updatePolyline();
};

/**
 * Pressure (bar) the water source itself provides — set when the suction
 * point is a pressurized hydrant. `null` = unpressurized source, a pump at
 * the source is assumed (its output pressure starts the line).
 */
let sourcePressure: number | null = null;

function pathMeters(path: GeoPoint[]): number {
	let total = 0;
	for (let i = 0; i < path.length - 1; i++) total += distanceTo(path[i], path[i + 1]);
	return total;
}

/**
 * Slope and pressure warnings of the drawn line. The pressure rule runs per
 * stretch: from the source (hydrant pressure or the source pump's outlet
 * pressure) to the first booster pump, then from each pump with its outlet
 * pressure (plan §6.13). Heights come from the joined route profile.
 */
function lineWarnings(
	pumpStore: ReturnType<typeof usePumpCalculationStore>,
	pumpPositions: PumpPosition[],
	realDistance: number
): PumpLineWarnings {
	const legs = routedLegs ?? [];
	const fallbacks = [...new Set(legs.map((l) => l.fallback).filter((f) => f !== null))];
	const incomplete = legs.some((l) => l.coverage.basemap === 'partial');
	const slope = slopeNotRecommended({
		metersOver25: legs.reduce((sum, l) => sum + l.metersOver25, 0),
		metersOver50: legs.reduce((sum, l) => sum + l.metersOver50, 0)
	});
	// Joined profile along the line (legs in order, distances offset).
	const s: number[] = [];
	const h: number[] = [];
	let offset = 0;
	let complete = legs.length > 0;
	for (const leg of legs) {
		if (!leg.profile) complete = false;
		else {
			leg.profile.s.forEach((d, i) => {
				s.push(d + offset);
				h.push(leg.profile!.heights[i]);
			});
		}
		offset += leg.planMeters;
	}
	let pressure: ReturnType<typeof evaluateDownhillPressure> = null;
	if (complete && s.length > 0) {
		// Pump distances are in the reported (3D) metres; the profile's distances
		// run along the drawn 2D line.
		const scale = offset > 0 && realDistance > 0 ? offset / realDistance : 1;
		const cuts = pumpPositions.map((p) => ({
			atM: p.distanceFromStart * scale,
			sourceBar: pumpStore.outputPressure
		}));
		pressure = evaluateDownhillPressure(
			stretchesAlongLine(s, h, sourcePressure ?? pumpStore.outputPressure, cuts),
			pumpStore.maxHosePressure
		);
	}
	return {
		notRecommended: slope || pressure?.level === 'warning',
		pressureLevel: pressure?.level ?? null,
		staticPressureMaxBar: pressure?.staticPressureMaxBar ?? null,
		fallbacks,
		incomplete
	};
}

export function usePumpCalculation() {
	const route = useRoute();
	const { t } = useI18n();

	const isActive = computed(() => route.path.includes('supplypipe'));

	const setSuctionPoint = (latlng?: GeoPoint, pressure: number | null = null) => {
		const point =
			latlng || (rootMap ? { lat: rootMap.getCenter().lat, lng: rootMap.getCenter().lng } : null);
		if (!point || !rootMap) return;

		sourcePressure = pressure;
		// A manually placed suction point no longer follows a pond's shore;
		// useMarkerAsWaterSource sets this again right after for pond areas.
		pondSource = null;
		pondSnapToken++;

		if (!suctionPoint) {
			const { iconUrl, size, anchor } = getMarkerConfig('suctionPoint');
			suctionPoint = new maplibregl.Marker({
				element: createMarkerElement(iconUrl, size),
				anchor,
				draggable: true
			});
			suctionPoint.setLngLat([point.lng, point.lat]).addTo(rootMap);
			suctionPoint.on('dragend', () => {
				// Dragged away from the hydrant → its pressure no longer applies.
				sourcePressure = null;
				// …and a pond-sourced point stays where the user put it.
				pondSource = null;
				pondSnapToken++;
				updatePolyline();
			});
			suctionPoint.getElement().addEventListener('click', () => {
				if (calculationResult.value) selectResultEntry('suction');
			});
		} else {
			suctionPoint.setLngLat([point.lng, point.lat]);
		}

		const pressureLine =
			pressure !== null
				? `<div>${t('pumpCalculation.sourcePressureUsed', { pressure })}</div>`
				: '';
		const popup = new maplibregl.Popup({ offset: [0, -48] });
		popup.setHTML(`
		<div class="pump-popup">
			<b>${t('pumpCalculation.suctionPoint')}</b>
			${pressureLine}
		</div>
	`);
		suctionPoint.setPopup(popup);

		suctionPointSet.value = true;
		updatePolyline();
	};

	/**
	 * Offers a tapped water-source marker as the suction point. A numeric
	 * `fire_hydrant:pressure` tag becomes the line's starting pressure (no
	 * pump at the source); otherwise a source pump is still assumed.
	 */
	const useMarkerAsWaterSource = async (ref: OsmRef, coords: GeoPoint) => {
		const node = await getMapNodeById(ref);
		const emergency = node?.tags?.emergency;
		const isWaterSource =
			emergency === 'fire_hydrant' ||
			emergency === 'suction_point' ||
			emergency === 'water_tank' ||
			emergency === 'fire_water_pond';
		if (!node || !isWaterSource) return;

		const pressure = parseHydrantPressure(node.tags);
		let point: GeoPoint =
			node.lat !== undefined && node.lon !== undefined ? { lat: node.lat, lng: node.lon } : coords;
		// A pond area is pumped from its shore (or its mapped suction point),
		// not its center: take the spot nearest to the fire point, if one is set.
		const isPond = isPondArea(node);
		if (isPond) {
			const reference = targetPoint ? getMarkerLngLat(targetPoint) : point;
			const target = await resolveAccessPoint(node, reference);
			if (target) {
				point = targetPoint
					? await suctionPointOnShore(target, reference)
					: accessTargetPoint(target);
			}
		}

		const alert = await alertController.create({
			header: t('pumpCalculation.useAsSource.title'),
			message:
				pressure !== null
					? t('pumpCalculation.sourcePressureUsed', { pressure })
					: t('pumpCalculation.sourcePumpRequired'),
			buttons: [
				{ text: t('pumpCalculation.useAsSource.cancel'), role: 'cancel' },
				{ text: t('pumpCalculation.useAsSource.confirm'), role: 'confirm' }
			]
		});
		await alert.present();
		const { role } = await alert.onDidDismiss();
		if (role === 'confirm') {
			setSuctionPoint(point, pressure);
			if (isPond) {
				pondSource = node;
				// The fire point may have moved while the dialog was open.
				void snapPondSuctionToFirePoint();
			}
		}
	};

	const calculatePumpRequirements = async () => {
		const pumpStore = usePumpCalculationStore();
		if (pumpStore.outputPressure <= pumpStore.inputPressure) {
			const alert = await alertController.create({
				header: t('pumpCalculation.error.title'),
				message: t('pumpCalculation.error.pressureDifference'),
				buttons: ['OK']
			});
			await alert.present();
			return;
		}

		if (!suctionPoint || !targetPoint) {
			return;
		}
		// Wait for the routed line so the calculation runs along the same
		// geometry the map shows; without a routed path use the marker chain.
		if (routingPromise) await routingPromise;
		const path = routedPathPoints ?? markerChain();
		const { points } = resamplePolyline(path);
		const { points: elevationData, elevationIgnored } = await getElevationDataForPoints(points);
		const calculated = getPumpLocationMarkers(elevationData, sourcePressure);
		const { pumpPositions } = calculated;
		// The calculation runs on the 3D length of the resampled line; every
		// distance shown (panel, chart, segment labels) is scaled to the routed
		// legs' reported (3D) metres, so the panel, the map label and the nearby
		// list agree (plan §6.4). Positions on the map use the drawn 2D line.
		const planDistance = pathMeters(path);
		const realDistance =
			routedPathPoints && routedLegs
				? routedLegs.reduce((sum, leg) => sum + leg.meters, 0)
				: planDistance;
		const toPlan = realDistance > 0 ? planDistance / realDistance : 1;
		const scale = calculated.realDistance > 0 ? realDistance / calculated.realDistance : 1;
		for (const point of elevationData) {
			if (point.distance !== undefined) point.distance *= scale;
		}
		let previousStart = 0;
		for (const pump of pumpPositions) {
			pump.distanceFromStart = Math.round(pump.distanceFromStart * scale);
			pump.distanceFromPrev = pump.distanceFromStart - previousStart;
			pump.neededBTubes = Math.ceil(pump.distanceFromPrev / pumpStore.tubeLength);
			previousStart = pump.distanceFromStart;
		}

		// The panel lists all marker details now — no popups in the result view
		// (tapping a marker selects its panel entry instead).
		suctionPoint.setPopup(null);

		// One hose-count label per stretch: suction → pump 1 → … → fire object.
		const tubesLabel = t('pumpCalculation.pump.tubes');
		const boundaries = [0, ...pumpPositions.map((p) => p.distanceFromStart), realDistance];
		segmentLabels = [];
		for (let i = 0; i < boundaries.length - 1; i++) {
			const segmentDistance = boundaries[i + 1] - boundaries[i];
			if (segmentDistance < 1) continue;
			const tubes = Math.ceil(segmentDistance / pumpStore.tubeLength);
			segmentLabels.push({
				point: pointAlongPath(path, ((boundaries[i] + boundaries[i + 1]) / 2) * toPlan),
				label: `~${tubes} ${pumpStore.hoseName}-${tubesLabel}`
			});
		}
		setPumpLineGeometry(path);

		// Remove old pump markers
		pumpMarkers.forEach((m) => m.remove());
		pumpMarkers.length = 0;

		// Add new pump markers; tapping one selects its result-panel entry.
		pumpPositions.forEach(({ marker }, index) => {
			if (rootMap) marker.addTo(rootMap);
			marker.getElement().addEventListener('click', () => {
				selectResultEntry(`pump-${index}`);
			});
			pumpMarkers.push(marker);
		});

		selectedResultEntry.value = null;

		calculationResult.value = {
			lineMeters: realDistance,
			warnings: lineWarnings(pumpStore, pumpPositions, realDistance),
			pumpPositions,
			elevationData,
			// The source pump only exists when the line isn't hydrant-fed.
			pumpCount: pumpPositions.length + (sourcePressure === null ? 1 : 0),
			realDistance,
			elevation: Math.round(
				elevationData[elevationData.length - 1].elevation - elevationData[0].elevation
			),
			suctionPoint,
			targetPoint,
			wayPoints,
			elevationIgnored,
			sourcePressure
		};
	};
	recalculate = calculatePumpRequirements;

	watch(isActive, (newValue) => {
		if (!newValue) {
			// Clean up all markers
			if (suctionPoint) {
				suctionPoint.remove();
				suctionPoint = null;
			}
			if (targetPoint) {
				targetPoint.remove();
				targetPoint = null;
			}
			wayPoints.forEach((m) => m.remove());
			wayPoints.length = 0;
			pumpMarkers.forEach((m) => m.remove());
			pumpMarkers.length = 0;
			routedPathPoints = null;
			routedLegs = null;
			lineSegments = [];
			routingPromise = null;
			routingToken++; // invalidate any in-flight routing
			segmentLabels = [];
			sourcePressure = null;
			pondSource = null;
			pondSnapToken++;
			// A pending auto-recalc firing after teardown would recreate markers.
			if (autoRecalcTimer) {
				clearTimeout(autoRecalcTimer);
				autoRecalcTimer = null;
			}

			// Clear polyline + labels
			if (rootMap) {
				const source = rootMap.getSource(PUMP_LINE_SOURCE) as maplibregl.GeoJSONSource;
				if (source) {
					source.setData({ type: 'FeatureCollection', features: [] });
				}
			}

			suctionPointSet.value = false;
			firePointSet.value = false;
			calculationResult.value = null;
		}
	});

	const markerSetAlert = async (latlng: GeoPoint) => {
		const alert = await alertController.create({
			header: t('pumpCalculation.alert.title'),
			inputs: [
				{
					label: t('pumpCalculation.fireObject'),
					type: 'radio',
					value: 'fireObject'
				},
				{
					label: t('pumpCalculation.suctionPoint'),
					type: 'radio',
					value: 'suctionPoint'
				},
				{
					label: t('pumpCalculation.wayPoint'),
					type: 'radio',
					value: 'wayPoint'
				}
			],
			buttons: [t('pumpCalculation.setPosition')]
		});

		alert.onDidDismiss().then((alertData) => {
			if (!alertData.data) {
				return;
			}
			const value = alertData.data.values;
			if (value === 'fireObject') {
				setTargetPoint(latlng);
			} else if (value === 'suctionPoint') {
				setSuctionPoint(latlng);
			} else if (value === 'wayPoint') {
				setWayPoint(latlng);
			}
		});

		await alert.present();
	};

	return {
		isActive,
		getPolylineBounds,
		hasPolyline,
		setMap,
		restoreMapState,
		setSuctionPoint,
		setTargetPoint,
		setWayPoint,
		useMarkerAsWaterSource,
		suctionPointSet,
		firePointSet,
		calculatePumpRequirements,
		calculationResult,
		selectedResultEntry,
		selectResultEntry,
		markerSetAlert
	};
}
