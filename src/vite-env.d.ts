/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Commit label for dev/preview builds (empty for releases) — see `getBuildLabel` in vite.config.ts. */
declare const __APP_BUILD_LABEL__: string;

interface ImportMetaEnv {
	readonly VITE_PROTOMAPS_API_KEY: string;
	/** Overrides the base URL for the static OSM data extract (§4.3). Defaults
	 * to the production R2 custom domain when unset — see `staticDataApi.ts`. */
	readonly VITE_DATA_BASE_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent<{}, {}, any>;
	export default component;
}
