import { computed } from 'vue';
import { useRoute } from 'vue-router';
import L from 'leaflet';
const layer = new L.LayerGroup();

let rootMap: L.Map | null = null;
const suctionPoint: L.Marker = new L.Marker();
const targetPoint: L.Marker = new L.Marker();
const wayPoints: L.Marker[] = [];
const line = new L.Polyline([]);

function setMap(map: L.Map) {
	rootMap = map;
	layer.addTo(rootMap);
}

console.log(suctionPoint.getLatLng());

const updatePolyline = () => {
	if (!suctionPoint.getLatLng() || !targetPoint.getLatLng()) {
		return;
	}
	const allPoints = [suctionPoint, ...wayPoints, targetPoint];
	const latLngs = allPoints.map((point) => point.getLatLng());
	line.setLatLngs(latLngs);
	layer.addLayer(line);
};

const setSuctionPoint = () => {
	const latLng = rootMap?.getCenter();
	suctionPoint.setLatLng(latLng);
	layer.addLayer(suctionPoint);
	updatePolyline();
};

const setTargetPoint = () => {
	const latLng = rootMap?.getCenter();
	targetPoint.setLatLng(latLng);
	layer.addLayer(targetPoint);
	updatePolyline();
};

const setWayPoint = () => {
	const latLng = rootMap?.getCenter();
	const wayPoint = new L.Marker(latLng);
	wayPoints.push(wayPoint);
	layer.addLayer(wayPoint);
	updatePolyline();
};

export function usePumpCalculation() {
	const route = useRoute();

	const isActive = computed(() => route.path.includes('supplyPipe'));

	return { isActive, layer, setMap, setSuctionPoint, setTargetPoint, setWayPoint };
}
