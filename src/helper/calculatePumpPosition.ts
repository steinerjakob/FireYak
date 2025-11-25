import { ElevationPoint } from '@/helper/elevationData';
import L, { Marker } from 'leaflet';
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
	marker: Marker;
	neededBTubes: number;
};

async function calculatePumpPosition(
	t: any,
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
			const pumpStore = usePumpCalculationStore();

			// Find the last point where pressure was above inputPressure
			let pumpPlacementIndex = i - 1;
			while (
				pumpPlacementIndex >= 0 &&
				elevationPoints[pumpPlacementIndex].pressure! < inputPressure
			) {
				pumpPlacementIndex--;
			}

			// If no suitable point found (shouldn't happen if start pressure is high enough), default to current point
			const pumpPoint =
				pumpPlacementIndex >= 0 ? elevationPoints[pumpPlacementIndex] : elevationPoints[i];

			const prevPump = pumps[pumps.length - 1];
			const marker = new Marker(L.latLng(pumpPoint.latLng.lat, pumpPoint.latLng.lng), {
				icon: pumpIcon
			});

			const distanceFromPrev = Math.round(pumpPoint.distance! - (prevPump?.distanceFromStart || 0));
			const neededBTubes = Math.round(distanceFromPrev / pumpStore.tubeLength);

			const pumpInfo = {
				lat: pumpPoint.latLng.lat,
				lon: pumpPoint.latLng.lng,
				elevation: pumpPoint.elevation,
				distanceFromStart: Math.round(pumpPoint.distance!),
				distanceFromPrev,
				pressureAtTrigger: Math.floor(pumpPoint.pressure! * 100) / 100, // Use the pressure at the chosen pump point
				riseFromStart: Math.round(pumpPoint.elevation - startElevation),
				riseFromPrev: Math.round(pumpPoint.elevation - (prevPump?.elevation || startElevation)),
				neededBTubes,
				marker
			};
			marker.bindPopup(provideMarkerPopup(t, pumpInfo));
			pumps.push(pumpInfo);

			// Reset the loop index, realDistance, and elevationOld to the state of the pumpPoint
			i = pumpPlacementIndex;
			realDistance = pumpPoint.distance!;
			elevationOld = pumpPoint.elevation;

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
	const popup = L.popup({
		maxWidth: 400
	});

	const inpuPressure = t('pumpCalculation.pump.inputPressure');
	const distanceFromStart = t('pumpCalculation.pump.distanceFromStart');
	const riseFromStart = t('pumpCalculation.pump.elevationDifference');

	const title = t('pumpCalculation.pump.title');
	const tubes = t('pumpCalculation.pump.tubes');
	const snippet = `B-${tubes}: ~${pump.neededBTubes}<br>${distanceFromStart}: ~${pump.distanceFromPrev}m<br>${riseFromStart}: ${pump.riseFromPrev}m`;
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
		t,
		elevationPoints,
		pumpCalculationStore.pressureLost / 100,
		pumpCalculationStore.inputPressure,
		pumpCalculationStore.outputPressure
	);
	return { pumpPositions, realDistance };
}
