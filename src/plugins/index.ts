/**
 * plugins/index.ts
 *
 * Automatically included in `./src/main.ts`
 */

// Plugins
import pinia from '@/store';
import router from '@/router';
import { IonicVue } from '@ionic/vue';

// Types
import type { App } from 'vue';

export function registerPlugins(app: App) {
	app.use(IonicVue).use(router).use(pinia);
}
