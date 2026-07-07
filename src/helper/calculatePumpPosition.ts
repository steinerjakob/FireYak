import { ElevationPoint } from '@/helper/elevationData';
import maplibregl from 'maplibre-gl';
import markerPump from '@/assets/markers/markerpump.png';
import { usePumpCalculationStore } from '@/store/pumpCalculationSettings';

export type PumpPosition = {
	lat: number;
	lon: number;
	elevation: number;
	distanceFromStart: number; // meters (approx)
	distanceFromPrev: number; // meters
	pressureAtTrigger: number; // bar
	riseFromStart: number; // meters
	riseFromPrev: number; //meters
	marker: maplibregl.Marker;
	neededBTubes: number;
};

function createPumpMarkerElement(): HTMLImageElement {
	const el = document.createElement('img');
	el.src = markerPump;
	el.style.width = '48px';
	el.style.height = '48px';
	return el;
}

function calculatePumpPosition(
	t: any,
	elevationPoints: ElevationPoint[],
	pressureLost: number,
	inputPressure: number,
	outputPressure: number,
	targetPressure: number,
	sourcePressure: number | null
): { pumps: PumpPosition[]; realDistance: number } {
	const pumps: PumpPosition[] = [];
	const pumpStore = usePumpCalculationStore();

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
	// A pressurized hydrant feeds the line directly with its own pressure;
	// otherwise a pump at the water source provides `outputPressure`.
	const hasSourcePump = sourcePressure === null;
	let pressure = sourcePressure ?? outputPressure;
	// Index of the point the last pump was placed on — the backtracking search
	// below must never go back to it, or a single segment that eats the whole
	// pressure budget (cliff-steep terrain) would loop forever. With a
	// hydrant-fed line there is no pump at index 0 yet, so placing one right
	// at the source is allowed.
	let lastPumpIndex = hasSourcePump ? 0 : -1;

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

		// Every booster pump needs `inputPressure` (min. 1.5 bar); the fire
		// object itself needs the nozzle pressure (Strahlrohrdruck, ~5 bar),
		// so the floor is higher at the very last point.
		const isLastPoint = i === elevationPoints.length - 1;
		const pressureFloor = isLastPoint ? Math.max(targetPressure, inputPressure) : inputPressure;
		if (pressure <= pressureFloor) {
			// Find the last point since the previous pump where the line still
			// had enough pressure to feed a pump.
			let placementIndex = i - 1;
			while (
				placementIndex > lastPumpIndex &&
				elevationPoints[placementIndex].pressure! < inputPressure
			) {
				placementIndex--;
			}
			if (placementIndex <= lastPumpIndex) {
				// No valid point since the previous pump (one segment consumed the
				// whole budget) — place at the current point so the loop advances.
				placementIndex = i;
			}
			const pumpPoint = elevationPoints[placementIndex];

			const prevPump = pumps[pumps.length - 1];
			const marker = new maplibregl.Marker({
				element: createPumpMarkerElement(),
				anchor: 'bottom'
			}).setLngLat([pumpPoint.latLng.lng, pumpPoint.latLng.lat]);

			const distanceFromPrev = Math.round(pumpPoint.distance! - (prevPump?.distanceFromStart ?? 0));
			const neededBTubes = Math.ceil(distanceFromPrev / pumpStore.tubeLength);

			const pumpInfo: PumpPosition = {
				lat: pumpPoint.latLng.lat,
				lon: pumpPoint.latLng.lng,
				elevation: pumpPoint.elevation,
				distanceFromStart: Math.round(pumpPoint.distance!),
				distanceFromPrev,
				pressureAtTrigger: Math.floor(pumpPoint.pressure! * 100) / 100, // Use the pressure at the chosen pump point
				riseFromStart: Math.round(pumpPoint.elevation - startElevation),
				riseFromPrev: Math.round(pumpPoint.elevation - (prevPump?.elevation ?? startElevation)),
				neededBTubes,
				marker
			};
			marker.setPopup(provideMarkerPopup(t, pumpInfo));
			pumps.push(pumpInfo);

			// Reset the loop index, realDistance, and elevationOld to the state of the pumpPoint
			lastPumpIndex = placementIndex;
			i = placementIndex;
			realDistance = pumpPoint.distance ?? 0;
			elevationOld = pumpPoint.elevation;

			// A booster pump adds its output on top of the incoming pressure
			// (doctrine: p_a = p + p_e) — only the very first pump at the
			// suction point starts from plain outputPressure.
			pressure = outputPressure + inputPressure;
		}
	}

	// final rounding of pressure not strictly required here; return pump positions
	return { pumps, realDistance };
}

function provideMarkerPopup(t: any, pump: PumpPosition): maplibregl.Popup {
	const popup = new maplibregl.Popup({ maxWidth: '400px', offset: [0, -48] });
	const pumpStore = usePumpCalculationStore();

	const inpuPressure = t('pumpCalculation.pump.inputPressure');
	const distanceFromStart = t('pumpCalculation.pump.distanceFromStart');
	const riseFromStart = t('pumpCalculation.pump.elevationDifference');

	const title = t('pumpCalculation.pump.title');
	const tubes = t('pumpCalculation.pump.tubes');
	const snippet = `${pumpStore.hoseName}-${tubes}: ~${pump.neededBTubes}<br>${distanceFromStart}: ~${pump.distanceFromPrev}m<br>${riseFromStart}: ${pump.riseFromPrev}m`;
	const subDescription = `${inpuPressure}: ${pump.pressureAtTrigger.toFixed(2)}`;

	popup.setHTML(`
		<div class="pump-popup">
			<b>${title}</b>
			<div>${snippet}</div>
			<div>${subDescription}</div>
		</div>
	`);
	return popup;
}

export function getPumpLocationMarkers(
	t: any,
	elevationPoints: ElevationPoint[],
	sourcePressure: number | null = null
) {
	const pumpCalculationStore = usePumpCalculationStore();
	const { pumps: pumpPositions, realDistance } = calculatePumpPosition(
		t,
		elevationPoints,
		pumpCalculationStore.pressureLost / 100,
		pumpCalculationStore.inputPressure,
		pumpCalculationStore.outputPressure,
		pumpCalculationStore.targetPressure,
		sourcePressure
	);
	return { pumpPositions, realDistance };
}
