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
import { getRoutedPath } from '@/mapHandler/nearbyRouting';
import { alertController } from '@ionic/vue';
import { GeoPoint, distanceTo } from '@/types/geo';

const PUMP_LINE_SOURCE = 'pump-line';
const PUMP_LINE_LAYER = 'pump-line-layer';
const PUMP_LINE_LABEL_LAYER = 'pump-line-label-layer';

let rootMap: maplibregl.Map | null = null;
let suctionPoint: maplibregl.Marker | null = null;
let targetPoint: maplibregl.Marker | null = null;
const wayPoints: maplibregl.Marker[] = [];
const pumpMarkers: maplibregl.Marker[] = [];

export interface CalculationResult {
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
}

const calculationResult = ref<CalculationResult | null>(null);

function setMap(map: maplibregl.Map) {
	rootMap = map;
	// Add pump line source/layer if not present
	if (!map.getSource(PUMP_LINE_SOURCE)) {
		map.addSource(PUMP_LINE_SOURCE, {
			type: 'geojson',
			// Holds the hose line plus one labeled midpoint per pump-to-pump segment.
			data: { type: 'FeatureCollection', features: [] }
		});
		map.addLayer({
			id: PUMP_LINE_LAYER,
			type: 'line',
			source: PUMP_LINE_SOURCE,
			paint: {
				'line-color': '#3388ff',
				'line-width': 3
			}
		});
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
		{
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
			properties: {}
		}
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
	const legs: (GeoPoint[] | null)[] = [];
	for (let i = 0; i < chain.length - 1; i++) {
		legs.push(
			await getRoutedPath(chain[i], chain[i + 1], {
				clampToRoads: settingsStore.clampHosesToRoads
			})
		);
	}
	if (token !== routingToken) return; // markers moved meanwhile — superseded

	const path: GeoPoint[] = [chain[0]];
	legs.forEach((leg, i) => {
		const points = leg ?? [chain[i], chain[i + 1]];
		path.push(...points.slice(1));
	});
	routedPathPoints = path;
	setPumpLineGeometry(path);
}

const updatePolyline = () => {
	if (!suctionPoint || !targetPoint || !rootMap) {
		return;
	}
	sortWaypoints();
	const chain = markerChain();

	// Draw the straight chain immediately (responsive while dragging), then
	// swap in the routed geometry once it resolves. Moving markers invalidates
	// the calculated segment labels.
	routedPathPoints = null;
	segmentLabels = [];
	setPumpLineGeometry(chain);
	routingPromise = updateRoutedPolyline(chain).catch((e) => {
		console.warn('Pump line routing failed, keeping straight line:', e);
	});
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
	} else {
		targetPoint.setLngLat([point.lng, point.lat]);
	}

	targetPoint.on('dragend', () => {
		updatePolyline();
	});

	firePointSet.value = true;
	updatePolyline();
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
	// Restore polyline data
	updatePolyline();
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

export function usePumpCalculation() {
	const route = useRoute();
	const { t } = useI18n();

	const isActive = computed(() => route.path.includes('supplypipe'));

	const setSuctionPoint = (latlng?: GeoPoint) => {
		const point =
			latlng || (rootMap ? { lat: rootMap.getCenter().lat, lng: rootMap.getCenter().lng } : null);
		if (!point || !rootMap) return;

		if (!suctionPoint) {
			const { iconUrl, size, anchor } = getMarkerConfig('suctionPoint');
			suctionPoint = new maplibregl.Marker({
				element: createMarkerElement(iconUrl, size),
				anchor,
				draggable: true
			});
			suctionPoint.setLngLat([point.lng, point.lat]).addTo(rootMap);
		} else {
			suctionPoint.setLngLat([point.lng, point.lat]);
		}

		suctionPoint.on('dragend', () => {
			updatePolyline();
		});

		const popup = new maplibregl.Popup({ offset: [0, -48] });
		popup.setHTML(`
		<div class="pump-popup">
			<b>${t('pumpCalculation.suctionPoint')}</b>
		</div>
	`);
		suctionPoint.setPopup(popup);

		suctionPointSet.value = true;
		updatePolyline();
	};

	const updateTargetMarker = (
		pumpPositions: PumpPosition[],
		realDistance: number,
		elevations: ElevationPoint[]
	) => {
		const pumpStore = usePumpCalculationStore();

		const inpuPressure = t('pumpCalculation.pump.inputPressure');
		const distanceFromStart = t('pumpCalculation.pump.distanceFromStart');
		const riseFromStart = t('pumpCalculation.pump.elevationDifference');

		const lastPump = pumpPositions[pumpPositions.length - 1];
		const prevDistance = lastPump?.distanceFromStart ?? 0;
		const prevElevation = lastPump?.elevation ?? elevations[0].elevation;

		const distance = realDistance - prevDistance;

		const neededBTubes = Math.ceil(distance / pumpStore.tubeLength);
		const lastElevation = elevations[elevations.length - 1];
		// Round to whole meters: DEM elevations carry decimals whose float
		// noise would otherwise leak into the display.
		const elevation = Math.round(lastElevation.elevation - prevElevation);
		const pressure = lastElevation.pressure;

		const title = t('pumpCalculation.fireObject');
		const tubes = t('pumpCalculation.pump.tubes');

		const snippet = `${pumpStore.hoseName}-${tubes}: ~${neededBTubes}<br>${distanceFromStart}: ~${distance.toFixed(0)}m<br>${riseFromStart}: ${elevation}m`;
		const subDescription = `${inpuPressure}: ${pressure?.toFixed(0)}`;

		const popup = new maplibregl.Popup({ maxWidth: '400px', offset: [0, -48] });
		popup.setHTML(`
		<div class="pump-popup">
			<b>${title}</b>
			<div>${snippet}</div>
			<div>${subDescription}</div>
		</div>
	`);
		targetPoint?.setPopup(popup);
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
		const { realDistance, pumpPositions } = getPumpLocationMarkers(t, elevationData);
		updateTargetMarker(pumpPositions, realDistance, elevationData);

		// One hose-count label per stretch: suction → pump 1 → … → fire object.
		const tubesLabel = t('pumpCalculation.pump.tubes');
		const boundaries = [0, ...pumpPositions.map((p) => p.distanceFromStart), realDistance];
		segmentLabels = [];
		for (let i = 0; i < boundaries.length - 1; i++) {
			const segmentDistance = boundaries[i + 1] - boundaries[i];
			if (segmentDistance < 1) continue;
			const tubes = Math.ceil(segmentDistance / pumpStore.tubeLength);
			segmentLabels.push({
				point: pointAlongPath(path, (boundaries[i] + boundaries[i + 1]) / 2),
				label: `~${tubes} ${pumpStore.hoseName}-${tubesLabel}`
			});
		}
		setPumpLineGeometry(path);

		// Remove old pump markers
		pumpMarkers.forEach((m) => m.remove());
		pumpMarkers.length = 0;

		// Add new pump markers
		pumpPositions.forEach(({ marker }) => {
			if (rootMap) marker.addTo(rootMap);
			pumpMarkers.push(marker);
		});

		calculationResult.value = {
			pumpPositions,
			elevationData,
			pumpCount: pumpPositions.length + 1,
			realDistance,
			elevation: Math.round(
				elevationData[elevationData.length - 1].elevation - elevationData[0].elevation
			),
			suctionPoint,
			targetPoint,
			wayPoints,
			elevationIgnored
		};
	};

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
			routingPromise = null;
			routingToken++; // invalidate any in-flight routing
			segmentLabels = [];

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
		suctionPointSet,
		firePointSet,
		calculatePumpRequirements,
		calculationResult,
		markerSetAlert
	};
}
