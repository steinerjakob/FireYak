import { namedFlavor, type Flavor } from '@protomaps/basemaps';

/**
 * Custom Protomaps flavor based on "light" with OSM OpenMapTiles (OSM Bright) colors.
 */
export const osmFlavor: Flavor = {
	...namedFlavor('light'),

	// Background & earth
	background: '#f8f4f0',
	earth: '#f8f4f0',

	// Land use
	park_a: '#d8e8c8',
	park_b: '#d8e8c8',
	hospital: '#ffddee',
	industrial: '#ece8d0',
	school: '#f0e8f8',
	wood_a: '#add19e',
	wood_b: '#a0c8a0',
	pedestrian: '#ededed',
	scrub_a: '#dde6c6',
	scrub_b: '#c8d8a8',
	glacier: '#ffffff',
	sand: '#f5eebc',
	beach: '#f5eebc',
	aerodrome: '#e8ecf0',
	runway: '#ffffff',
	water: '#adc8e6',
	zoo: '#d8e8c8',
	military: '#e0e0e0',

	// Tunnels
	tunnel_other_casing: '#cfcdca',
	tunnel_minor_casing: '#cfcdca',
	tunnel_link_casing: '#e9ac77',
	tunnel_major_casing: '#e9ac77',
	tunnel_highway_casing: '#e9ac77',
	tunnel_other: '#ffffff',
	tunnel_minor: '#ffffff',
	tunnel_link: '#fff4c6',
	tunnel_major: '#fff4c6',
	tunnel_highway: '#ffdaa6',

	// Structures
	pier: '#f8f4f0',
	buildings: '#dfdbd7',

	// Roads
	minor_service_casing: '#cfcdca',
	minor_casing: '#cfcdca',
	link_casing: '#e9ac77',
	major_casing_late: '#e9ac77',
	highway_casing_late: '#e9ac77',
	other: '#ffffff',
	minor_service: '#ffffff',
	minor_a: '#ffffff',
	minor_b: '#ffffff',
	link: '#ffeeaa',
	major_casing_early: '#e9ac77',
	major: '#ffeeaa',
	highway_casing_early: '#e9ac77',
	highway: '#ffcc88',

	// Rail & borders
	railway: '#bbbbbb',
	boundaries: '#9e9cab',

	// Bridges
	bridges_other_casing: '#cfcdca',
	bridges_minor_casing: '#cfcdca',
	bridges_link_casing: '#e9ac77',
	bridges_major_casing: '#e9ac77',
	bridges_highway_casing: '#e9ac77',
	bridges_other: '#ffffff',
	bridges_minor: '#ffffff',
	bridges_link: '#ffeeaa',
	bridges_major: '#ffeeaa',
	bridges_highway: '#ffcc88',

	// Labels
	roads_label_minor: '#776655',
	roads_label_minor_halo: '#f8f4f0',
	roads_label_major: '#776655',
	roads_label_major_halo: '#f8f4f0',
	ocean_label: '#74aee9',
	subplace_label: '#663333',
	subplace_label_halo: '#ffffff',
	city_label: '#333333',
	city_label_halo: '#ffffff',
	state_label: '#663333',
	state_label_halo: '#ffffff',
	country_label: '#333344',
	address_label: '#666666',
	address_label_halo: '#ffffff',

	// Landcover
	landcover: {
		grassland: '#d8e8c8',
		barren: '#f5eebc',
		urban_area: '#e6e6e6',
		farmland: '#d8efd2',
		glacier: '#ffffff',
		scrub: '#dde6c6',
		forest: '#c4e7d2'
	}
};
