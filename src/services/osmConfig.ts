import * as OSM from 'osm-api';
import { Capacitor } from '@capacitor/core';

/**
 * OpenStreetMap endpoint + OAuth2 client configuration.
 *
 * Production (app.fireyak.org) and the native apps talk to www.openstreetmap.org
 * with the production OAuth2 client. Web preview deployments (Cloudflare Pages,
 * see `plans/cloudflare-pages-previews.md`) can point at the OSM dev server
 * instead by setting, at build time:
 *
 * - `VITE_OSM_URL`       e.g. `https://master.apis.dev.openstreetmap.org`
 * - `VITE_OSM_CLIENT_ID` an OAuth2 app registered on that server
 *
 * Both are ignored on native builds: their redirect URI is fixed to
 * https://app.fireyak.org and registered on the production client only.
 */

const PRODUCTION_OSM_URL = 'https://www.openstreetmap.org';
const PRODUCTION_CLIENT_ID = '5RmzpVAEyynIFoe3Lj5IdMvQ-1L-Z1ZhzQ0U33JJE-o';

const allowOverrides = !Capacitor.isNativePlatform();
const urlOverride = allowOverrides
	? import.meta.env.VITE_OSM_URL?.trim().replace(/\/+$/, '')
	: undefined;
const clientIdOverride = allowOverrides ? import.meta.env.VITE_OSM_CLIENT_ID?.trim() : undefined;

/** Website base URL (OAuth endpoints, object pages, editor, account settings). */
export const OSM_WEB_URL = urlOverride || PRODUCTION_OSM_URL;

/** OAuth2 client ID registered on {@link OSM_WEB_URL}. */
export const OSM_CLIENT_ID = clientIdOverride || PRODUCTION_CLIENT_ID;

// osm-api defaults to api.openstreetmap.org (and derives www.openstreetmap.org
// for its OAuth popup from that), so only reconfigure it when overridden. The
// dev server serves the API, the website and OAuth from the same host.
if (urlOverride) {
	OSM.configure({ apiUrl: urlOverride });
}
