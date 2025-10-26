import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import L, { LatLng, Marker } from 'leaflet';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import wayPointIcon from '@/assets/markers/waypoint.png';
import { distanceBetweenMultiplePoints } from '@/helper/distanceCalculation';
import { ElevationPoint, getElevationDataForPoints } from '@/helper/elevationData';
import { getPumpLocationMarkers, PumpPosition } from '@/helper/calculatePumpPosition';
import { useI18n } from 'vue-i18n';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';

const layer = new L.LayerGroup();
const pumpLayer = new L.LayerGroup();
let rootMap: L.Map | null = null;
let suctionPoint: L.Marker | null = null;
let targetPoint: L.Marker | null = null;
const wayPoints: L.Marker[] = [];
const line = new L.Polyline([]);

export interface CalculationResult {
	realDistance: number;
	pumpMarkers: Marker[];
	wayPoints: Marker[];
	suctionPoint: Marker;
	targetPoint: Marker;
	pumpCount: number;
	elevationData: ElevationPoint[];
	pumpPositions: PumpPosition[];
}

const calculationResult = ref<CalculationResult | null>(null);

function setMap(map: L.Map) {
	rootMap = map;
	layer.addTo(rootMap);
}

const suctionPointSet = ref(false);
const firePointSet = ref(false);

const sortWaypoints = (): void => {
	if (!suctionPoint || wayPoints.length < 2) {
		// No need to sort if there are 0 or 1 waypoints
		return;
	}

	let lastPoint = suctionPoint;
	const remainingWaypoints = [...wayPoints];
	const sortedWaypoints: L.Marker[] = [];

	while (remainingWaypoints.length > 0) {
		let closestIndex = -1;
		let minDistance = Infinity;

		remainingWaypoints.forEach((point, index) => {
			const distance = lastPoint.getLatLng().distanceTo(point.getLatLng());
			if (distance < minDistance) {
				minDistance = distance;
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
	if (!suctionPoint || !targetPoint) {
		return;
	}
	sortWaypoints();
	const allPoints = [suctionPoint, ...wayPoints, targetPoint];
	const latLngs = allPoints.map((point) => point.getLatLng());
	line.setLatLngs(latLngs);
	layer.addLayer(line);
};

const setSuctionPoint = () => {
	const latLng = rootMap?.getCenter();
	if (!suctionPoint) {
		suctionPoint = new L.Marker(latLng as LatLng, {
			icon: getMarkerIcon('suctionPoint'),
			draggable: true
		});
	} else {
		suctionPoint.setLatLng(latLng as LatLng);
	}

	suctionPoint.on('dragend', () => {
		updatePolyline();
	});
	layer.addLayer(suctionPoint);
	suctionPointSet.value = true;
	updatePolyline();
};

const setTargetPoint = () => {
	const latLng = rootMap?.getCenter();
	if (!targetPoint) {
		targetPoint = new L.Marker(latLng as LatLng, {
			icon: getMarkerIcon('firePoint'),
			draggable: true
		});
	} else {
		targetPoint.setLatLng(latLng as LatLng);
	}

	targetPoint.on('dragend', () => {
		updatePolyline();
	});

	layer.addLayer(targetPoint);
	firePointSet.value = true;
	updatePolyline();
};

const removeWayPoint = (wayPointToRemove: L.Marker) => {
	const index = wayPoints.indexOf(wayPointToRemove);
	if (index > -1) {
		wayPoints.splice(index, 1);
		layer.removeLayer(wayPointToRemove);
		updatePolyline();
	}
};

const setWayPoint = () => {
	const latLng = rootMap?.getCenter();
	if (!latLng) return;
	const wayPoint = new L.Marker(latLng as LatLng, {
		icon: getMarkerIcon('wayPoint'),
		draggable: true
	});
	wayPoint.on('dragend', () => {
		updatePolyline();
	});

	const popup = L.popup();
	const popupContent = document.createElement('div');
	popupContent.style.textAlign = 'center';
	const removeButton = document.createElement('button');
	removeButton.textContent = '🗑'; // Set the UTF-8 trash can icon directly as text content
	removeButton.style.color = 'red'; // Colorize the icon
	removeButton.style.backgroundColor = 'transparent'; // Remove default button background
	removeButton.style.border = 'none'; // Remove default button border
	removeButton.style.cursor = 'pointer'; // Indicate it's clickable
	removeButton.style.fontSize = '2em'; // Make the icon larger for better visibility
	removeButton.style.padding = '0'; // Remove default padding
	removeButton.onclick = () => removeWayPoint(wayPoint);
	popupContent.appendChild(removeButton);

	popup.setContent(popupContent);
	wayPoint.bindPopup(popup);

	wayPoints.push(wayPoint);
	layer.addLayer(wayPoint);
	updatePolyline();
};

const getMarkerIcon = (type: 'firePoint' | 'suctionPoint' | 'wayPoint') => {
	let icon = suctionPointIcon;
	if (type === 'firePoint') {
		icon = firepointIcon;
	} else if (type === 'wayPoint') {
		icon = wayPointIcon;
	}
	return L.icon({
		iconUrl: icon,
		iconSize: type == 'wayPoint' ? [32, 32] : [48, 48],
		iconAnchor: type !== 'wayPoint' ? [24, 48] : undefined,
		popupAnchor: type !== 'wayPoint' ? [0, -48] : [0, -12]
	});
};

export function usePumpCalculation() {
	const route = useRoute();
	const { t } = useI18n();

	const isActive = computed(() => route.path.includes('supplypipe'));

	const updateTargetMarker = (
		pumpPositions: PumpPosition[],
		realDistance: number,
		elevations: ElevationPoint[]
	) => {
		const pumpStore = usePumpCalculationStore();
		const popup = L.popup({
			maxWidth: 400
		});

		const inpuPressure = t('pumpCalculation.pump.inputPressure');
		const distanceFromStart = t('pumpCalculation.pump.distanceFromStart');
		const riseFromStart = t('pumpCalculation.pump.elevationDifference');

		const lastPump = pumpPositions[pumpPositions.length - 1];
		const prevDistance = lastPump?.distanceFromStart || 0;
		const prevElevation = lastPump?.elevation || elevations[0].elevation;

		const neededBTubes = Math.round((realDistance - prevDistance) / pumpStore.tubeLength);
		const lastElevation = elevations[elevations.length - 1];
		const elevation = lastElevation.elevation - prevElevation;
		const pressure = lastElevation.pressure;

		const title = t('pumpCalculation.fireObject');
		const tubes = t('pumpCalculation.pump.tubes');

		const snippet = `B-${tubes}: ~${neededBTubes}<br>${distanceFromStart}: ~${realDistance.toFixed(2)}m<br>${riseFromStart}: ${elevation}m`;
		const subDescription = `${inpuPressure}: ${pressure?.toFixed(0)}`;

		popup.setContent(`
		<div class="pump-popup">
			<b>${title}</b>
			<div>${snippet}</div>
			<div>${subDescription}</div>
		</div>
	`);
		targetPoint?.bindPopup(popup);
	};

	const calculatePumpRequirements = async () => {
		if (!suctionPoint || !targetPoint) {
			return;
		}
		const pointsToCalculate = [suctionPoint, ...wayPoints, targetPoint].map((point) =>
			point.getLatLng()
		);
		const { distance, points } = distanceBetweenMultiplePoints(pointsToCalculate);
		console.log('Full Distance', distance);
		const elevationData = await getElevationDataForPoints(points);
		const { pumpMarkers, realDistance, pumpPositions } = await getPumpLocationMarkers(
			t,
			elevationData
		);
		updateTargetMarker(pumpPositions, realDistance, elevationData);
		pumpLayer.clearLayers();
		pumpMarkers.forEach((marker) => {
			pumpLayer.addLayer(marker);
		});
		layer.addLayer(pumpLayer);

		targetPoint?.openPopup();

		console.log('Elevation Data', pumpMarkers, elevationData);

		calculationResult.value = {
			pumpMarkers,
			pumpPositions,
			elevationData,
			pumpCount: pumpMarkers.length + 1,
			realDistance,
			suctionPoint,
			targetPoint,
			wayPoints
		};
	};

	watch(isActive, (newValue) => {
		if (!newValue) {
			layer.clearLayers();
			pumpLayer.clearLayers();
			suctionPoint = null;
			targetPoint = null;
			wayPoints.length = 0;
			suctionPointSet.value = false;
			firePointSet.value = false;
		}
	});

	return {
		isActive,
		layer,
		setMap,
		setSuctionPoint,
		setTargetPoint,
		setWayPoint,
		suctionPointSet,
		firePointSet,
		calculatePumpRequirements,
		calculationResult
	};
}
