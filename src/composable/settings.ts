import { useSettingsStore, type ThemeSetting, MapLayerSetting } from '@/store/settingsStore';
import { Preferences } from '@capacitor/preferences';

const THEME_KEY = 'theme';
const SHOW_ZOOM_BUTTONS_KEY = 'show_zoom_buttons';
const MAP_LAYER_KEY = 'map_layer';
const TERRAIN_3D_KEY = 'terrain_3d';
const OSM_AUTH_KEY = 'osm_token';
const WIKIMEDIA_ACCESS_TOKEN_KEY = 'wikimedia_access_token';
const WIKIMEDIA_REFRESH_TOKEN_KEY = 'wikimedia_refresh_token';
const WIKIMEDIA_LICENSE_KEY = 'wikimedia_license_accepted';

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
			osmAuthKey,
			wikimediaAccessTokenResult,
			wikimediaRefreshTokenResult,
			wikimediaLicenseResult
		] = await Promise.all([
			Preferences.get({ key: THEME_KEY }),
			Preferences.get({ key: SHOW_ZOOM_BUTTONS_KEY }),
			Preferences.get({ key: MAP_LAYER_KEY }),
			Preferences.get({ key: TERRAIN_3D_KEY }),
			Preferences.get({ key: OSM_AUTH_KEY }),
			Preferences.get({ key: WIKIMEDIA_ACCESS_TOKEN_KEY }),
			Preferences.get({ key: WIKIMEDIA_REFRESH_TOKEN_KEY }),
			Preferences.get({ key: WIKIMEDIA_LICENSE_KEY })
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

		if (osmAuthKey.value) {
			settingsStore.setOsmAuthToken(osmAuthKey.value);
		}

		if (wikimediaAccessTokenResult.value) {
			settingsStore.setWikimediaAccessToken(wikimediaAccessTokenResult.value);
		}

		if (wikimediaRefreshTokenResult.value) {
			settingsStore.setWikimediaRefreshToken(wikimediaRefreshTokenResult.value);
		}

		if (wikimediaLicenseResult.value) {
			settingsStore.setWikimediaLicenseAccepted(wikimediaLicenseResult.value === 'true');
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
	 * Persists both Wikimedia OAuth tokens and mirrors them into the settings store.
	 */
	const saveWikimediaTokens = async (accessToken: string, refreshToken: string) => {
		settingsStore.setWikimediaAccessToken(accessToken);
		settingsStore.setWikimediaRefreshToken(refreshToken);
		await Promise.all([
			Preferences.set({ key: WIKIMEDIA_ACCESS_TOKEN_KEY, value: accessToken }),
			Preferences.set({ key: WIKIMEDIA_REFRESH_TOKEN_KEY, value: refreshToken })
		]);
	};

	/**
	 * Removes both Wikimedia OAuth tokens from persistent storage and clears the store.
	 */
	const removeWikimediaTokens = async () => {
		settingsStore.setWikimediaAccessToken('');
		settingsStore.setWikimediaRefreshToken('');
		await Promise.all([
			Preferences.remove({ key: WIKIMEDIA_ACCESS_TOKEN_KEY }),
			Preferences.remove({ key: WIKIMEDIA_REFRESH_TOKEN_KEY })
		]);
	};

	/**
	 * Reads the persisted Wikimedia access token (and mirrors it into the settings store if present).
	 */
	const getWikimediaAccessToken = async (): Promise<string | null> => {
		const { value } = await Preferences.get({ key: WIKIMEDIA_ACCESS_TOKEN_KEY });
		if (value) settingsStore.setWikimediaAccessToken(value);
		return value ?? null;
	};

	/**
	 * Reads the persisted Wikimedia refresh token (and mirrors it into the settings store if present).
	 */
	const getWikimediaRefreshToken = async (): Promise<string | null> => {
		const { value } = await Preferences.get({ key: WIKIMEDIA_REFRESH_TOKEN_KEY });
		if (value) settingsStore.setWikimediaRefreshToken(value);
		return value ?? null;
	};

	/**
	 * Persists the Wikimedia license accepted state and mirrors it into the settings store.
	 */
	const saveWikimediaLicenseAccepted = async (accepted: boolean) => {
		settingsStore.setWikimediaLicenseAccepted(accepted);
		await Preferences.set({
			key: WIKIMEDIA_LICENSE_KEY,
			value: String(accepted)
		});
	};

	/**
	 * Reads the persisted Wikimedia license accepted state.
	 */
	const getWikimediaLicenseAccepted = async (): Promise<boolean> => {
		const { value } = await Preferences.get({ key: WIKIMEDIA_LICENSE_KEY });
		const accepted = value === 'true';
		settingsStore.setWikimediaLicenseAccepted(accepted);
		return accepted;
	};

	return {
		loadSettings,
		saveTheme,
		saveShowZoomButtons,
		saveMapLayer,
		saveTerrain3d,
		saveOsmAuthToken,
		removeOsmAuthToken,
		getOsmAuthToken,
		saveWikimediaTokens,
		removeWikimediaTokens,
		getWikimediaAccessToken,
		getWikimediaRefreshToken,
		saveWikimediaLicenseAccepted,
		getWikimediaLicenseAccepted
	};
}
