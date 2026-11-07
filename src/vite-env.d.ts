/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
	readonly VITE_PROTOMAPS_API_KEY: string;
	/** Overrides the base URL for the static OSM data extract (§4.3). Defaults
	 * to the production R2 custom domain when unset — see `staticDataApi.ts`. */
	readonly VITE_DATA_BASE_URL?: string;
	/** OSM website/API base URL for web preview builds (e.g. the OSM dev server).
	 * Defaults to https://www.openstreetmap.org; ignored on native — see `osmConfig.ts`. */
	readonly VITE_OSM_URL?: string;
	/** OAuth2 client ID registered on `VITE_OSM_URL`. Defaults to the production
	 * client; ignored on native — see `osmConfig.ts`. */
	readonly VITE_OSM_CLIENT_ID?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent<{}, {}, any>;
	export default component;
}
