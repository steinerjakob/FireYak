import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import L, { LatLng } from 'leaflet';
import suctionPointIcon from '@/assets/markers/suctionpoint.png';
import firepointIcon from '@/assets/markers/firepoint.png';
import wayPointIcon from '@/assets/markers/waypoint.png';
import { distanceBetweenMultiplePoints } from '@/helper/distanceCalculation';
import { getElevationDataForPoints } from '@/helper/elevationData';
import { calculatePumpPosition, getPumpLocationMarkers } from '@/helper/calculatePumpPosition';

const PIPE_LENGTH = 20; // in meters

const layer = new L.LayerGroup();
const pumpLayer = new L.LayerGroup();
let rootMap: L.Map | null = null;
let suctionPoint: L.Marker | null = null;
let targetPoint: L.Marker | null = null;
const wayPoints: L.Marker[] = [];
const line = new L.Polyline([]);

function setMap(map: L.Map) {
	rootMap = map;
	layer.addTo(rootMap);
}

const suctionPointSet = ref(false);
const firePointSet = ref(false);

const updatePolyline = () => {
	if (!suctionPoint || !targetPoint) {
		return;
	}
	const allPoints = [suctionPoint, ...wayPoints, targetPoint];
	const latLngs = allPoints.map((point) => point.getLatLng());
	line.setLatLngs(latLngs);
	layer.addLayer(line);
};

const setSuctionPoint = () => {
	const latLng = rootMap?.getCenter();
	if (!suctionPoint) {
		suctionPoint = new L.Marker(latLng as LatLng, { icon: getMarkerIcon('suctionPoint') });
	} else {
		suctionPoint.setLatLng(latLng as LatLng);
	}
	layer.addLayer(suctionPoint);
	suctionPointSet.value = true;
	updatePolyline();
};

const setTargetPoint = () => {
	const latLng = rootMap?.getCenter();
	if (!targetPoint) {
		targetPoint = new L.Marker(latLng as LatLng, { icon: getMarkerIcon('firePoint') });
	} else {
		targetPoint.setLatLng(latLng as LatLng);
	}

	layer.addLayer(targetPoint);
	firePointSet.value = true;
	updatePolyline();
};

const setWayPoint = () => {
	const latLng = rootMap?.getCenter();
	const wayPoint = new L.Marker(latLng as LatLng, { icon: getMarkerIcon('wayPoint') });
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
		iconAnchor: type !== 'wayPoint' ? [24, 48] : undefined
	});
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
	const pumpMarkers = await getPumpLocationMarkers(elevationData);
	pumpLayer.clearLayers();
	pumpMarkers.forEach((marker) => {
		pumpLayer.addLayer(marker);
	});
	layer.addLayer(pumpLayer);

	console.log('Elevation Data', pumpMarkers);
};

export function usePumpCalculation() {
	const route = useRoute();

	const isActive = computed(() => route.path.includes('supplyPipe'));

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
		calculatePumpRequirements
	};
}
