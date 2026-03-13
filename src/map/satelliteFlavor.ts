import { namedFlavor, type Flavor } from '@protomaps/basemaps';

/**
 * Transparent Protomaps flavor for overlaying on satellite/aerial raster tiles.
 * High-contrast roads, labels, and boundaries against dark satellite imagery.
 */
export const satelliteFlavor: Flavor = {
	...namedFlavor('light'),

	// Background & earth — fully transparent to show satellite imagery
	background: 'transparent',
	earth: 'transparent',

	// Land use — transparent, satellite imagery is the ground truth
	park_a: 'transparent',
	park_b: 'transparent',
	hospital: 'transparent',
	industrial: 'transparent',
	school: 'transparent',
	wood_a: 'transparent',
	wood_b: 'transparent',
	pedestrian: 'transparent',
	scrub_a: 'transparent',
	scrub_b: 'transparent',
	glacier: 'transparent',
	sand: 'transparent',
	beach: 'transparent',
	aerodrome: 'transparent',
	runway: 'rgba(200, 210, 255, 0.5)',
	water: 'transparent',
	zoo: 'transparent',
	military: 'transparent',

	// Tunnels — dashed dark casing with bright fill
	tunnel_other_casing: 'rgba(0, 0, 0, 0.6)',
	tunnel_minor_casing: 'rgba(0, 0, 0, 0.6)',
	tunnel_link_casing: 'rgba(0, 0, 0, 0.6)',
	tunnel_major_casing: 'rgba(0, 0, 0, 0.6)',
	tunnel_highway_casing: 'rgba(0, 0, 0, 0.7)',
	tunnel_other: 'rgba(255, 255, 255, 0.45)',
	tunnel_minor: 'rgba(255, 255, 255, 0.45)',
	tunnel_link: 'rgba(255, 220, 120, 0.5)',
	tunnel_major: 'rgba(255, 220, 120, 0.5)',
	tunnel_highway: 'rgba(255, 160, 80, 0.6)',

	// Structures
	pier: 'rgba(220, 220, 210, 0.6)',
	buildings: 'rgba(255, 255, 255, 0.35)',

	// Roads — bright fills with strong dark casings for contrast
	minor_service_casing: 'rgba(0, 0, 0, 0.5)',
	minor_casing: 'rgba(0, 0, 0, 0.5)',
	link_casing: 'rgba(0, 0, 0, 0.6)',
	major_casing_late: 'rgba(0, 0, 0, 0.65)',
	highway_casing_late: 'rgba(0, 0, 0, 0.7)',
	other: 'rgba(255, 255, 255, 0.7)',
	minor_service: 'rgba(255, 255, 255, 0.7)',
	minor_a: 'rgba(255, 255, 255, 0.75)',
	minor_b: 'rgba(255, 255, 255, 0.75)',
	link: 'rgba(255, 220, 80, 0.85)',
	major_casing_early: 'rgba(0, 0, 0, 0.6)',
	major: 'rgba(255, 220, 80, 0.9)',
	highway_casing_early: 'rgba(0, 0, 0, 0.7)',
	highway: '#f0903c',

	// Rail & borders
	railway: 'rgba(255, 255, 255, 0.7)',
	boundaries: '#d46a7a',

	// Bridges — fully opaque with strong casings
	bridges_other_casing: 'rgba(0, 0, 0, 0.6)',
	bridges_minor_casing: 'rgba(0, 0, 0, 0.6)',
	bridges_link_casing: 'rgba(0, 0, 0, 0.7)',
	bridges_major_casing: 'rgba(0, 0, 0, 0.7)',
	bridges_highway_casing: 'rgba(0, 0, 0, 0.8)',
	bridges_other: 'rgba(255, 255, 255, 0.8)',
	bridges_minor: 'rgba(255, 255, 255, 0.8)',
	bridges_link: 'rgba(255, 220, 80, 0.9)',
	bridges_major: 'rgba(255, 220, 80, 0.95)',
	bridges_highway: '#f0903c',

	// Labels — bright white text with strong dark halos
	roads_label_minor: '#000000',
	roads_label_minor_halo: '#ffffff',
	roads_label_major: '#000000',
	roads_label_major_halo: '#ffffff',
	ocean_label: '#8ecae6',
	subplace_label: '#000000',
	subplace_label_halo: '#ffffff',
	city_label: '#000000',
	city_label_halo: '#ffffff',
	state_label: '#000000',
	state_label_halo: '#ffffff',
	country_label: '#000000',
	address_label: '#000000',
	address_label_halo: '#ffffff',

	// Landcover — transparent
	landcover: {
		grassland: 'transparent',
		barren: 'transparent',
		urban_area: 'transparent',
		farmland: 'transparent',
		glacier: 'transparent',
		scrub: 'transparent',
		forest: 'transparent'
	}
};
