import { namedFlavor, type Flavor } from '@protomaps/basemaps';

/**
 * Transparent Protomaps flavor for overlaying on satellite/aerial raster tiles.
 * Based on outdoors colors, with transparent land areas and high-contrast labels.
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
	runway: 'rgba(165, 173, 213, 0.4)',
	water: 'transparent',
	zoo: 'transparent',
	military: 'transparent',

	// Tunnels — semi-transparent for visibility on satellite
	tunnel_other_casing: 'rgba(0, 0, 0, 0.3)',
	tunnel_minor_casing: 'rgba(0, 0, 0, 0.3)',
	tunnel_link_casing: 'rgba(0, 0, 0, 0.3)',
	tunnel_major_casing: 'rgba(0, 0, 0, 0.3)',
	tunnel_highway_casing: 'rgba(0, 0, 0, 0.3)',
	tunnel_other: 'rgba(255, 255, 255, 0.3)',
	tunnel_minor: 'rgba(255, 255, 255, 0.3)',
	tunnel_link: 'rgba(248, 201, 135, 0.4)',
	tunnel_major: 'rgba(248, 201, 135, 0.4)',
	tunnel_highway: 'rgba(246, 141, 106, 0.5)',

	// Structures
	pier: 'rgba(200, 200, 200, 0.5)',
	buildings: 'rgba(180, 175, 165, 0.5)',

	// Roads — visible with some transparency
	minor_service_casing: 'rgba(0, 0, 0, 0.2)',
	minor_casing: 'rgba(0, 0, 0, 0.2)',
	link_casing: 'rgba(0, 0, 0, 0.3)',
	major_casing_late: 'rgba(0, 0, 0, 0.3)',
	highway_casing_late: 'rgba(0, 0, 0, 0.4)',
	other: 'rgba(255, 255, 255, 0.5)',
	minor_service: 'rgba(255, 255, 255, 0.5)',
	minor_a: 'rgba(255, 255, 255, 0.5)',
	minor_b: 'rgba(255, 255, 255, 0.5)',
	link: 'rgba(248, 201, 135, 0.7)',
	major_casing_early: 'rgba(0, 0, 0, 0.3)',
	major: 'rgba(248, 201, 135, 0.8)',
	highway_casing_early: 'rgba(0, 0, 0, 0.4)',
	highway: 'rgba(246, 141, 106, 0.9)',

	// Rail & borders
	railway: 'rgba(255, 255, 255, 0.5)',
	boundaries: 'rgba(175, 106, 117, 0.8)',

	// Bridges — slightly more opaque than regular roads
	bridges_other_casing: 'rgba(0, 0, 0, 0.3)',
	bridges_minor_casing: 'rgba(0, 0, 0, 0.3)',
	bridges_link_casing: 'rgba(0, 0, 0, 0.4)',
	bridges_major_casing: 'rgba(0, 0, 0, 0.4)',
	bridges_highway_casing: 'rgba(0, 0, 0, 0.5)',
	bridges_other: 'rgba(255, 255, 255, 0.6)',
	bridges_minor: 'rgba(255, 255, 255, 0.6)',
	bridges_link: 'rgba(248, 201, 135, 0.8)',
	bridges_major: 'rgba(248, 201, 135, 0.8)',
	bridges_highway: 'rgba(246, 141, 106, 0.9)',

	// Labels — white text with dark halos for readability on varied satellite imagery
	roads_label_minor: '#ffffff',
	roads_label_minor_halo: 'rgba(0, 0, 0, 0.7)',
	roads_label_major: '#ffffff',
	roads_label_major_halo: 'rgba(0, 0, 0, 0.7)',
	ocean_label: '#ffffff',
	subplace_label: '#ffffff',
	subplace_label_halo: 'rgba(0, 0, 0, 0.7)',
	city_label: '#ffffff',
	city_label_halo: 'rgba(0, 0, 0, 0.7)',
	state_label: '#ffffff',
	state_label_halo: 'rgba(0, 0, 0, 0.7)',
	country_label: '#ffffff',
	address_label: '#ffffff',
	address_label_halo: 'rgba(0, 0, 0, 0.7)',

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
