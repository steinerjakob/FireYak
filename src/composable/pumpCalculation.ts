import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import maplibregl from 'maplibre-gl';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import wayPointIcon from '@/assets/markers/waypoint.png';
import { distanceBetweenMultiplePoints } from '@/helper/distanceCalculation';
import { ElevationPoint, getElevationDataForPoints } from '@/helper/elevationData';
import { getPumpLocationMarkers, PumpPosition } from '@/helper/calculatePumpPosition';
import { useI18n } from 'vue-i18n';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';
import { alertController } from '@ionic/vue';
import { GeoPoint, distanceTo } from '@/types/geo';

const PUMP_LINE_SOURCE = 'pump-line';
const PUMP_LINE_LAYER = 'pump-line-layer';

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
}

const calculationResult = ref<CalculationResult | null>(null);

function setMap(map: maplibregl.Map) {
	rootMap = map;
	// Add pump line source/layer if not present
	if (!map.getSource(PUMP_LINE_SOURCE)) {
		map.addSource(PUMP_LINE_SOURCE, {
			type: 'geojson',
			data: {
				type: 'Feature',
				geometry: { type: 'LineString', coordinates: [] },
				properties: {}
			}
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

const updatePolyline = () => {
	if (!suctionPoint || !targetPoint || !rootMap) {
		return;
	}
	sortWaypoints();
	const allPoints = [suctionPoint, ...wayPoints, targetPoint];
	const coordinates = allPoints.map((m) => {
		const lngLat = m.getLngLat();
		return [lngLat.lng, lngLat.lat];
	});

	const source = rootMap.getSource(PUMP_LINE_SOURCE) as maplibregl.GeoJSONSource;
	if (source) {
		source.setData({
			type: 'Feature',
			geometry: { type: 'LineString', coordinates },
			properties: {}
		});
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
	return bounds;
}

function hasPolyline(): boolean {
	return Boolean(suctionPoint && targetPoint);
}

const setTargetPoint = (latlng?: GeoPoint) => {
	const point =
		latlng ||
		(rootMap ? { lat: rootMap.getCenter().lat, lng: rootMap.getCenter().lng } : null);
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

const setWayPoint = (latlng?: GeoPoint) => {
	const point =
		latlng ||
		(rootMap ? { lat: rootMap.getCenter().lat, lng: rootMap.getCenter().lng } : null);
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
			latlng ||
			(rootMap ? { lat: rootMap.getCenter().lat, lng: rootMap.getCenter().lng } : null);
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
		const prevDistance = lastPump?.distanceFromStart || 0;
		const prevElevation = lastPump?.elevation || elevations[0].elevation;

		const distance = realDistance - prevDistance;

		const neededBTubes = Math.round(distance / pumpStore.tubeLength);
		const lastElevation = elevations[elevations.length - 1];
		const elevation = lastElevation.elevation - prevElevation;
		const pressure = lastElevation.pressure;

		const title = t('pumpCalculation.fireObject');
		const tubes = t('pumpCalculation.pump.tubes');

		const snippet = `B-${tubes}: ~${neededBTubes}<br>${distanceFromStart}: ~${distance.toFixed(0)}m<br>${riseFromStart}: ${elevation}m`;
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
		const pointsToCalculate = [suctionPoint, ...wayPoints, targetPoint].map((point) =>
			getMarkerLngLat(point)
		);
		const { distance, points } = distanceBetweenMultiplePoints(pointsToCalculate);
		console.log('Full Distance', distance);
		const elevationData = await getElevationDataForPoints(points);
		const { realDistance, pumpPositions } = await getPumpLocationMarkers(t, elevationData);
		updateTargetMarker(pumpPositions, realDistance, elevationData);

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
			elevation: elevationData[elevationData.length - 1].elevation - elevationData[0].elevation,
			suctionPoint,
			targetPoint,
			wayPoints
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

			// Clear polyline
			if (rootMap) {
				const source = rootMap.getSource(PUMP_LINE_SOURCE) as maplibregl.GeoJSONSource;
				if (source) {
					source.setData({
						type: 'Feature',
						geometry: { type: 'LineString', coordinates: [] },
						properties: {}
					});
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
