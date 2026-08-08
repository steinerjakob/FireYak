import { defineStore } from 'pinia';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import {
	initSystemColorScheme,
	onSystemColorSchemeChange,
	systemPrefersDark
} from '@/composable/systemColorScheme';

export type ThemeSetting = 'light' | 'dark' | 'auto';
export type MapLayerSetting = 'standard' | 'satellite';

export type MarkerFilterKey =
	| 'fireHydrant'
	| 'suctionPoint'
	| 'waterTank'
	| 'fireWaterPond'
	| 'fireStation';
export type MarkerFilters = Record<MarkerFilterKey, boolean>;

/** Resolves a theme setting against the current system preference. */
const resolveIsDark = (theme: ThemeSetting) =>
	theme === 'dark' || (theme === 'auto' && systemPrefersDark.value);

/**
 * Applies the appropriate theme classes to the document based on the setting.
 * @param theme The theme setting ('light', 'dark', or 'auto')
 */
const applyThemeToDocument = (theme: ThemeSetting) => {
	const isDark = resolveIsDark(theme);

	// Toggle Ionic's dark palette class
	document.documentElement.classList.toggle('ion-palette-dark', isDark);

	// `ion-palette-light` pins the palette to light and, by design, opts the MD3
	// tokens out of the `prefers-color-scheme: dark` media query. It must
	// therefore only be set for an explicit light choice — leaving it on in
	// 'auto' mode would keep the CSS stuck in light after a system switch.
	document.documentElement.classList.toggle('ion-palette-light', theme === 'light');

	if (Capacitor.isNativePlatform()) {
		SystemBars.setStyle({ style: isDark ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
	}
};

/** Guards against stacking system-preference listeners on repeated init calls. */
let systemThemeListenerAttached = false;

const DEFAULT_MARKER_FILTERS: MarkerFilters = {
	fireHydrant: true,
	suctionPoint: true,
	waterTank: true,
	fireWaterPond: true,
	fireStation: true
};

export const useSettingsStore = defineStore('settings', {
	state: () => ({
		theme: 'auto' as ThemeSetting,
		showZoomButtons: true,
		mapLayer: 'standard' as MapLayerSetting,
		terrain3d: false,
		// When true, hose routes stick to the road network; when false (default)
		// they may cut through gardens/open ground (buildings always avoided).
		clampHosesToRoads: false,
		// When true, a line from the user position to the selected marker is
		// drawn on the map.
		showPathToMarker: true,
		osmAuthToken: '',
		markerFilters: { ...DEFAULT_MARKER_FILTERS } as MarkerFilters
	}),
	getters: {
		/** Whether the dark palette is currently active. */
		isDarkMode: (state) => resolveIsDark(state.theme)
	},
	actions: {
		setTheme(theme: ThemeSetting) {
			this.theme = theme;
			applyThemeToDocument(theme);
		},
		setShowZoomButtons(show: boolean) {
			this.showZoomButtons = show;
		},
		setMapLayer(mapLayer: MapLayerSetting) {
			this.mapLayer = mapLayer;
		},
		setTerrain3d(enabled: boolean) {
			this.terrain3d = enabled;
		},
		setClampHosesToRoads(enabled: boolean) {
			this.clampHosesToRoads = enabled;
		},
		setShowPathToMarker(enabled: boolean) {
			this.showPathToMarker = enabled;
		},
		setOsmAuthToken(token: string) {
			this.osmAuthToken = token;
		},
		setMarkerFilters(filters: MarkerFilters) {
			this.markerFilters = { ...filters };
		},
		/**
		 * Initializes the theme system. Should be called when the app starts.
		 *
		 * The system listener stays attached regardless of the current theme
		 * setting: it is what keeps `isDarkMode` truthful, and re-applying is a
		 * no-op while the user has pinned 'light' or 'dark'.
		 */
		initializeTheme() {
			initSystemColorScheme();

			if (!systemThemeListenerAttached) {
				systemThemeListenerAttached = true;
				onSystemColorSchemeChange(() => applyThemeToDocument(this.theme));
			}

			applyThemeToDocument(this.theme);
		}
	}
});
