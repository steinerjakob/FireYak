import { ElevationPoint } from '@/helper/elevationData';
import L from 'leaflet';
import markerPump from '@/assets/markers/markerPump.png';

const INPUT_PRESSURE = 1.5; // bar
const OUTPUT_PRESSURE = 10; // bar
const PRESSURE_LOST = 1.1 / 100; // bar per meter for 800l/min

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

export async function calculatePumpPosition(elevationPoints: ElevationPoint[]) {
	type PumpPosition = {
		lat: number;
		lon: number;
		elevation: number;
		distanceFromStart: number; // meters (approx)
		pressureAtTrigger: number; // bar
		riseFromStart: number; // meters
	};

	if (!elevationPoints || elevationPoints.length < 2) return [] as PumpPosition[];

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
	let pressure = OUTPUT_PRESSURE;

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
		pressure = pressure - delta / 10 - segment3D * PRESSURE_LOST;

		elevationOld = curr.elevation;

		if (pressure <= INPUT_PRESSURE) {
			const roundedPressure = Math.floor(pressure * 100) / 100;
			pumps.push({
				lat: curr.latLng.lat,
				lon: curr.latLng.lng,
				elevation: curr.elevation,
				distanceFromStart: Math.round(realDistance),
				pressureAtTrigger: roundedPressure,
				riseFromStart: Math.round(curr.elevation - startElevation)
			});

			// reset pressure to output after placing pump
			pressure = OUTPUT_PRESSURE;
		}
	}

	// final rounding of pressure not strictly required here; return pump positions
	return pumps;
}
const pumpIcon = L.icon({
	iconUrl: markerPump,
	iconSize: [48, 48],
	iconAnchor: [24, 48]
});

export async function getPumpLocationMarkers(elevationPoints: ElevationPoint[]) {
	const pumpPositions = await calculatePumpPosition(elevationPoints);
	return pumpPositions.map((pump, index) => {
		return new L.Marker(L.latLng(pump.lat, pump.lon), {
			icon: pumpIcon
		});
	});
}
