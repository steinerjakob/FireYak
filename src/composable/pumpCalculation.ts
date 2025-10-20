import { computed } from 'vue';
import { useRoute } from 'vue-router';
import L from 'leaflet';
const layer = new L.LayerGroup();

let rootMap: L.Map | null = null;
const suctionPoint: L.Marker = new L.Marker();
const targetPoint: L.Marker = new L.Marker();
// eslint-disable-next-line sonarjs/no-unused-collection
const wayPoints: L.Marker[] = [];

function setMap(map: L.Map) {
	rootMap = map;
	layer.addTo(rootMap);
}

export function usePumpCalculation() {
	const route = useRoute();

	const isActive = computed(() => route.path.includes('supplyPipe'));

	const setSuctionPoint = () => {
		const latLng = rootMap?.getCenter();
		suctionPoint.setLatLng(latLng);
		layer.addLayer(suctionPoint);
	};

	const setTargetPoint = () => {
		const latLng = rootMap?.getCenter();
		targetPoint.setLatLng(latLng);
		layer.addLayer(targetPoint);
	};

	const setWayPoint = () => {
		const latLng = rootMap?.getCenter();
		const wayPoint = new L.Marker(latLng);
		wayPoints.push(wayPoint);
		layer.addLayer(wayPoint);
	};

	return { isActive, layer, setMap, setSuctionPoint, setTargetPoint, setWayPoint };
}
