/**
 * plugins/index.ts
 *
 * Automatically included in `./src/main.ts`
 */

// Plugins
import pinia from '@/store';
import router from '@/router';
import { IonicVue } from '@ionic/vue';
import i18n from '@/plugins/i18n';

// Types
import type { App } from 'vue';

export function registerPlugins(app: App) {
	app.use(IonicVue).use(router).use(pinia).use(i18n);
}
