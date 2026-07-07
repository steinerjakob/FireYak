import {
	useSettingsStore,
	type ThemeSetting,
	MapLayerSetting,
	type MarkerFilters
} from '@/store/settingsStore';
import { Preferences } from '@capacitor/preferences';

const THEME_KEY = 'theme';
const SHOW_ZOOM_BUTTONS_KEY = 'show_zoom_buttons';
const MAP_LAYER_KEY = 'map_layer';
const TERRAIN_3D_KEY = 'terrain_3d';
const CLAMP_HOSES_TO_ROADS_KEY = 'clamp_hoses_to_roads';
const OSM_AUTH_KEY = 'osm_token';
const MARKER_FILTERS_KEY = 'marker_filters';

export function useSettings() {
	const settingsStore = useSettingsStore();

	/**
	 * Loads settings from persistent storage and updates the store.
	 * Also initializes the theme system to apply the correct theme on startup.
	 */
	const loadSettings = async () => {
		const [
			themeResult,
			showZoomButtonsResult,
			mapLayerResult,
			terrain3dResult,
			clampHosesToRoadsResult,
			osmAuthKey,
			markerFiltersResult
		] = await Promise.all([
			Preferences.get({ key: THEME_KEY }),
			Preferences.get({ key: SHOW_ZOOM_BUTTONS_KEY }),
			Preferences.get({ key: MAP_LAYER_KEY }),
			Preferences.get({ key: TERRAIN_3D_KEY }),
			Preferences.get({ key: CLAMP_HOSES_TO_ROADS_KEY }),
			Preferences.get({ key: OSM_AUTH_KEY }),
			Preferences.get({ key: MARKER_FILTERS_KEY })
		]);

		if (themeResult.value) {
			settingsStore.setTheme(themeResult.value as ThemeSetting);
		}

		if (showZoomButtonsResult.value) {
			settingsStore.setShowZoomButtons(showZoomButtonsResult.value === 'true');
		}

		if (mapLayerResult.value === 'standard' || mapLayerResult.value === 'satellite') {
			settingsStore.setMapLayer(mapLayerResult.value);
		}

		if (terrain3dResult.value) {
			settingsStore.setTerrain3d(terrain3dResult.value === 'true');
		}

		if (clampHosesToRoadsResult.value) {
			settingsStore.setClampHosesToRoads(clampHosesToRoadsResult.value === 'true');
		}

		if (osmAuthKey.value) {
			settingsStore.setOsmAuthToken(osmAuthKey.value);
		}

		if (markerFiltersResult.value) {
			try {
				const parsed = JSON.parse(markerFiltersResult.value) as MarkerFilters;
				settingsStore.setMarkerFilters({ ...settingsStore.markerFilters, ...parsed });
			} catch {
				// ignore malformed stored value; defaults remain
			}
		}

		// Initialize the theme system after loading settings
		// This ensures the theme is applied on app startup and listeners are set up
		settingsStore.initializeTheme();
	};

	/**
	 * Saves the theme setting to persistent storage and updates the store.
	 * @param theme The theme to save.
	 */
	const saveTheme = async (theme: ThemeSetting) => {
		settingsStore.setTheme(theme);
		await Preferences.set({
			key: THEME_KEY,
			value: theme
		});
	};

	/**
	 * Saves the zoom button visibility setting to persistent storage and updates the store.
	 * @param show The visibility state to save.
	 */
	const saveShowZoomButtons = async (show: boolean) => {
		settingsStore.setShowZoomButtons(show);
		await Preferences.set({
			key: SHOW_ZOOM_BUTTONS_KEY,
			value: String(show)
		});
	};

	/**
	 * Saves the map base layer selection to persistent storage and updates the store.
	 * @param mapLayer The map layer to save.
	 */
	const saveMapLayer = async (mapLayer: MapLayerSetting) => {
		settingsStore.setMapLayer(mapLayer);
		await Preferences.set({
			key: MAP_LAYER_KEY,
			value: mapLayer
		});
	};

	const saveTerrain3d = async (enabled: boolean) => {
		settingsStore.setTerrain3d(enabled);
		await Preferences.set({
			key: TERRAIN_3D_KEY,
			value: String(enabled)
		});
	};

	/**
	 * Saves whether hose routes must stick to the road network (see
	 * `clampHosesToRoads` in the settings store).
	 */
	const saveClampHosesToRoads = async (enabled: boolean) => {
		settingsStore.setClampHosesToRoads(enabled);
		await Preferences.set({
			key: CLAMP_HOSES_TO_ROADS_KEY,
			value: String(enabled)
		});
	};

	/**
	 * Persists the OSM OAuth token and mirrors it into the settings store.
	 */
	const saveOsmAuthToken = async (token: string) => {
		settingsStore.setOsmAuthToken(token);
		await Preferences.set({
			key: OSM_AUTH_KEY,
			value: token
		});
	};
	/**
	 * Removes the persisted OSM OAuth token and clears it from the settings store.
	 */
	const removeOsmAuthToken = async () => {
		settingsStore.setOsmAuthToken('');
		await Preferences.remove({ key: OSM_AUTH_KEY });
	};

	/**
	 * Reads the persisted OSM OAuth token (and mirrors it into the settings store if present).
	 */
	const getOsmAuthToken = async (): Promise<string | null> => {
		const { value } = await Preferences.get({ key: OSM_AUTH_KEY });
		if (value) settingsStore.setOsmAuthToken(value);
		return value ?? null;
	};

	/**
	 * Saves the marker filter settings to persistent storage and updates the store.
	 * @param filters The marker filters to save.
	 */
	const saveMarkerFilters = async (filters: MarkerFilters) => {
		settingsStore.setMarkerFilters(filters);
		await Preferences.set({
			key: MARKER_FILTERS_KEY,
			value: JSON.stringify(filters)
		});
	};

	return {
		loadSettings,
		saveTheme,
		saveShowZoomButtons,
		saveMapLayer,
		saveTerrain3d,
		saveClampHosesToRoads,
		saveOsmAuthToken,
		removeOsmAuthToken,
		getOsmAuthToken,
		saveMarkerFilters
	};
}
