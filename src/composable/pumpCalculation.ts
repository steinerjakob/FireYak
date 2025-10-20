import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import L, { LatLng } from 'leaflet';
const layer = new L.LayerGroup();

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
		suctionPoint = new L.Marker(latLng as LatLng);
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
		targetPoint = new L.Marker(latLng as LatLng);
	} else {
		targetPoint.setLatLng(latLng as LatLng);
	}

	layer.addLayer(targetPoint);
	firePointSet.value = true;
	updatePolyline();
};

const setWayPoint = () => {
	const latLng = rootMap?.getCenter();
	const wayPoint = new L.Marker(latLng as LatLng);
	wayPoints.push(wayPoint);
	layer.addLayer(wayPoint);
	updatePolyline();
};

export function usePumpCalculation() {
	const route = useRoute();

	const isActive = computed(() => route.path.includes('supplyPipe'));

	return {
		isActive,
		layer,
		setMap,
		setSuctionPoint,
		setTargetPoint,
		setWayPoint,
		suctionPointSet,
		firePointSet
	};
}
