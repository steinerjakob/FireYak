import { namedFlavor, type Flavor } from '@protomaps/basemaps';

/**
 * Custom Protomaps flavor based on "dark" with Mapbox Navigation Night v1 colors.
 */
export const nightFlavor: Flavor = {
	...namedFlavor('dark'),

	// Background & earth
	background: '#424d5c',
	earth: '#424d5c',

	// Land use
	park_a: '#43605b',
	park_b: '#3d574f',
	hospital: '#4b475c',
	industrial: '#424d5c',
	school: '#38464c',
	wood_a: '#283931',
	wood_b: '#2e4238',
	pedestrian: '#424d5c',
	scrub_a: '#354a3e',
	scrub_b: '#2e4035',
	glacier: '#9ca3a5',
	sand: '#2a323c',
	beach: '#2a323c',
	aerodrome: '#49506e',
	runway: '#3d4157',
	water: '#5d757e',
	zoo: '#43605b',
	military: '#3a414b',

	// Tunnels
	tunnel_other_casing: '#2f3032',
	tunnel_minor_casing: '#2f3032',
	tunnel_link_casing: '#2f3032',
	tunnel_major_casing: '#2f3032',
	tunnel_highway_casing: '#2f3032',
	tunnel_other: '#2c3035',
	tunnel_minor: '#2c3035',
	tunnel_link: '#2c3035',
	tunnel_major: '#2c3035',
	tunnel_highway: '#58759d',

	// Structures
	pier: '#424d5c',
	buildings: '#3a414b',

	// Roads
	minor_service_casing: '#49505b',
	minor_casing: '#49505b',
	link_casing: '#3b4554',
	major_casing_late: '#3b4554',
	highway_casing_late: '#3b4554',
	other: '#2c3035',
	minor_service: '#2c3035',
	minor_a: '#2c3035',
	minor_b: '#2c3035',
	link: '#5a6887',
	major_casing_early: '#3b4554',
	major: '#5a6887',
	highway_casing_early: '#3b4554',
	highway: '#58759d',

	// Rail & borders
	railway: '#787878',
	boundaries: '#a09daf',

	// Bridges
	bridges_other_casing: '#49505b',
	bridges_minor_casing: '#49505b',
	bridges_link_casing: '#3b4554',
	bridges_major_casing: '#3b4554',
	bridges_highway_casing: '#3b4554',
	bridges_other: '#2c3035',
	bridges_minor: '#2c3035',
	bridges_link: '#5a6887',
	bridges_major: '#5a6887',
	bridges_highway: '#58759d',

	// Labels
	roads_label_minor: '#e6e6e6',
	roads_label_minor_halo: '#3a4a5f',
	roads_label_major: '#e6e6e6',
	roads_label_major_halo: '#3a4a5f',
	ocean_label: '#8ecae6',
	subplace_label: '#acbcd2',
	subplace_label_halo: '#3a4a5f',
	city_label: '#acbcd2',
	city_label_halo: '#3a4a5f',
	state_label: '#acbcd2',
	state_label_halo: '#3a4a5f',
	country_label: '#acbcd2',
	address_label: '#acbcd2',
	address_label_halo: '#3a4a5f',

	// Landcover
	landcover: {
		grassland: '#283931',
		barren: '#2a323c',
		urban_area: '#424d5c',
		farmland: '#304035',
		glacier: '#9ca3a5',
		scrub: '#354a3e',
		forest: '#283931'
	}
};
