import { namedFlavor, type Flavor } from '@protomaps/basemaps';

export const outdoorsFlavor: Flavor = {
	...namedFlavor('light'),

	// Background & earth
	background: '#e0e0d1',
	earth: '#e0e0d1',

	// Land use
	park_a: '#a5cc8e',
	park_b: '#a7dd88',
	hospital: '#e6cabc',
	industrial: '#d1d4e0',
	school: '#e0cfae',
	wood_a: '#83cc66',
	wood_b: '#6bb84f',
	pedestrian: '#f2f2f2',
	scrub_a: '#a3d487',
	scrub_b: '#8fc472',
	glacier: '#edf3f8',
	sand: '#d6e28d',
	beach: '#d6e28d',
	aerodrome: '#bfc5e3',
	runway: '#a5add5',
	water: '#79bcec',
	zoo: '#a5cc8e',
	military: '#d9d9d9',

	// Tunnels
	tunnel_other_casing: '#babaab',
	tunnel_minor_casing: '#babaab',
	tunnel_link_casing: '#d6d6cd',
	tunnel_major_casing: '#d6d6cd',
	tunnel_highway_casing: '#d6d6cd',
	tunnel_other: '#f2f2f2',
	tunnel_minor: '#f2f2f2',
	tunnel_link: '#f2f2f2',
	tunnel_major: '#f2f2f2',
	tunnel_highway: '#ff9f80',

	// Structures
	pier: '#e0e0d1',
	buildings: '#c9c6b6',

	// Roads
	minor_service_casing: '#babaab',
	minor_casing: '#babaab',
	link_casing: '#d6d6cd',
	major_casing_late: '#d6d6cd',
	highway_casing_late: '#d6d6cd',
	other: '#f2f2f2',
	minor_service: '#f2f2f2',
	minor_a: '#f2f2f2',
	minor_b: '#f2f2f2',
	link: '#f8c987',
	major_casing_early: '#d6d6cd',
	major: '#f8c987',
	highway_casing_early: '#d6d6cd',
	highway: '#f68d6a',

	// Rail & borders
	railway: '#8f8f8f',
	boundaries: '#af6a75',

	// Bridges
	bridges_other_casing: '#babaab',
	bridges_minor_casing: '#babaab',
	bridges_link_casing: '#d6d6cd',
	bridges_major_casing: '#d6d6cd',
	bridges_highway_casing: '#d6d6cd',
	bridges_other: '#f2f2f2',
	bridges_minor: '#f2f2f2',
	bridges_link: '#f8c987',
	bridges_major: '#f8c987',
	bridges_highway: '#f68d6a',

	// Labels
	roads_label_minor: '#000000',
	roads_label_minor_halo: '#ffffff',
	roads_label_major: '#000000',
	roads_label_major_halo: '#ffffff',
	ocean_label: '#79bcec',
	subplace_label: '#000000',
	subplace_label_halo: '#ffffff',
	city_label: '#000000',
	city_label_halo: '#ffffff',
	state_label: '#000000',
	state_label_halo: '#ffffff',
	country_label: '#000000',
	address_label: '#000000',
	address_label_halo: '#ffffff',

	// Landcover
	landcover: {
		grassland: '#a5cc8e',
		barren: '#d6e28d',
		urban_area: '#d1d4e0',
		farmland: '#b8d6a0',
		glacier: '#edf3f8',
		scrub: '#a3d487',
		forest: '#83cc66'
	}
};
