/**
 * i18n key for a marker's generic title (used when it has no `name`).
 *
 * Shared by the info header, the nearby list and the pending-edits view so the
 * three never disagree. Suction pipes and suction hydrants are tagged as
 * hydrants in OSM (`emergency=fire_hydrant` + `fire_hydrant:pressure=suction`),
 * but they are not pressurised — a pump is needed — so they get their own
 * title, matching their suction-point map symbol.
 */
export function markerTitleKey(tags: Record<string, string> | undefined): string {
	switch (tags?.emergency) {
		case 'fire_hydrant':
			if (!isSuctionHydrant(tags)) return 'markerInfo.title.fireHydrant';
			// A pipe is a fixed suction pipe; any other type (pillar, underground…)
			// with suction pressure is a suction ("dry") hydrant.
			return tags?.['fire_hydrant:type']?.trim().toLowerCase() === 'pipe'
				? 'markerInfo.title.suctionPipe'
				: 'markerInfo.title.suctionHydrant';
		case 'water_tank':
			return 'markerInfo.title.waterTank';
		case 'suction_point':
			return 'markerInfo.title.suctionPoint';
		case 'fire_water_pond':
			return 'markerInfo.title.fireWaterPond';
	}
	if (tags?.amenity === 'fire_station') return 'markerInfo.title.fireStation';
	return 'markerInfo.title.locationInfo';
}

/** A hydrant-tagged object that needs a pump to draw water (suction pipe or suction hydrant). */
export function isSuctionHydrant(tags: Record<string, string> | undefined): boolean {
	// Tag values are case-sensitive by convention, but mappers do write
	// `Suction`; treat those the same so they don't fall back to "hydrant".
	return (
		tags?.emergency === 'fire_hydrant' &&
		tags?.['fire_hydrant:pressure']?.trim().toLowerCase() === 'suction'
	);
}
