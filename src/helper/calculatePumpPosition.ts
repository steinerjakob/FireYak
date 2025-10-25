import { ElevationPoint } from '@/helper/elevationData';
import L from 'leaflet';
import markerPump from '@/assets/markers/markerpump.png';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';

const flowRateAndPressureLostTable: { flowRate: number; pressureLost: number }[] = [
	{ flowRate: 0, pressureLost: 0 },
	{ flowRate: 200, pressureLost: 0.1 },
	{ flowRate: 400, pressureLost: 0.2 },
	{ flowRate: 600, pressureLost: 0.7 },
	{ flowRate: 800, pressureLost: 1.1 },
	{ flowRate: 1000, pressureLost: 1.7 },
	{ flowRate: 1200, pressureLost: 2.5 },
	{ flowRate: 1600, pressureLost: 4.5 }
];

export type PumpPosition = {
	lat: number;
	lon: number;
	elevation: number;
	distanceFromStart: number; // meters (approx)
	distanceFromPrev: number; // meters
	pressureAtTrigger: number; // bar
	riseFromStart: number; // meters
	riseFromPrev: number; //meters
};

async function calculatePumpPosition(
	elevationPoints: ElevationPoint[],
	pressureLost: number,
	inputPressure: number,
	outputPressure: number
): Promise<{ pumps: PumpPosition[]; realDistance: number }> {
	const pumps: PumpPosition[] = [];

	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
		const R = 6371000; // Earth radius in meters
		const dLat = toRad(lat2 - lat1);
		const dLon = toRad(lon2 - lon1);
		const a =
			Math.sin(dLat / 2) * Math.sin(dLat / 2) +
			Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
		return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	};

	let realDistance = 0;
	const startElevation = elevationPoints[0].elevation;
	let elevationOld = startElevation;
	let pressure = outputPressure;

	elevationPoints[0].pressure = pressure;

	for (let i = 1; i < elevationPoints.length; i++) {
		const prev = elevationPoints[i - 1];
		const curr = elevationPoints[i];

		const horizontal = haversine(
			prev.latLng.lat,
			prev.latLng.lng,
			curr.latLng.lat,
			curr.latLng.lng
		);
		const delta = curr.elevation - elevationOld;

		const segment3D = Math.sqrt(horizontal * horizontal + delta * delta);
		realDistance += segment3D;

		// pressure change: elevation difference (m) -> bar via /10, plus friction loss per meter
		pressure = pressure - delta / 10 - segment3D * pressureLost;

		elevationOld = curr.elevation;

		elevationPoints[i].pressure = pressure;
		elevationPoints[i].distance = realDistance;

		if (pressure <= inputPressure) {
			const roundedPressure = Math.floor(pressure * 100) / 100;
			const prevPump = pumps[pumps.length - 1];
			pumps.push({
				lat: curr.latLng.lat,
				lon: curr.latLng.lng,
				elevation: curr.elevation,
				distanceFromStart: Math.round(realDistance),
				distanceFromPrev: Math.round(realDistance - (prevPump?.distanceFromStart || 0)),
				pressureAtTrigger: roundedPressure,
				riseFromStart: Math.round(curr.elevation - startElevation),
				riseFromPrev: Math.round(curr.elevation - (prevPump?.elevation || startElevation))
			});

			// reset pressure to output after placing pump
			pressure = outputPressure;
		}
	}

	// final rounding of pressure not strictly required here; return pump positions
	return { pumps, realDistance };
}
const pumpIcon = L.icon({
	iconUrl: markerPump,
	iconSize: [48, 48],
	iconAnchor: [24, 48],
	popupAnchor: [0, -48]
});

function provideMarkerPopup(t: any, pump: PumpPosition) {
	const pumpStore = usePumpCalculationStore();
	const popup = L.popup({
		maxWidth: 400
	});

	const inpuPressure = t('pumpCalculation.pump.inputPressure');
	const distanceFromStart = t('pumpCalculation.pump.distanceFromStart');
	const riseFromStart = t('pumpCalculation.pump.elevationDifference');

	const neededBTubes = Math.round(pump.distanceFromPrev / pumpStore.tubeLength);

	const title = t('pumpCalculation.pump.title');
	const tubes = t('pumpCalculation.pump.tubes');
	const snippet = `B-${tubes}: ~${neededBTubes}<br>${distanceFromStart}: ~${pump.distanceFromPrev}m<br>${riseFromStart}: ${pump.riseFromPrev}m`;
	const subDescription = `${inpuPressure}: ${pump.pressureAtTrigger.toFixed(2)}`;

	popup.setContent(`
		<div class="pump-popup">
			<b>${title}</b>
			<div>${snippet}</div>
			<div>${subDescription}</div>
		</div>
	`);
	return popup;
}

export async function getPumpLocationMarkers(t: any, elevationPoints: ElevationPoint[]) {
	const pumpCalculationStore = usePumpCalculationStore();
	const { pumps: pumpPositions, realDistance } = await calculatePumpPosition(
		elevationPoints,
		pumpCalculationStore.pressureLost / 100,
		pumpCalculationStore.inputPressure,
		pumpCalculationStore.outputPressure
	);
	const markers = pumpPositions.map((pump) => {
		const marker = new L.Marker(L.latLng(pump.lat, pump.lon), {
			icon: pumpIcon
		});
		marker.bindPopup(provideMarkerPopup(t, pump));
		return marker;
	});
	return { pumpMarkers: markers, pumpPositions, realDistance };
}
