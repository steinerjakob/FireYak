/**
 * plugins/index.ts
 *
 * Automatically included in `./src/main.ts`
 */

// Plugins
import pinia from '@/store';
import router from '@/router';
import { IonicVue, isPlatform } from '@ionic/vue';
import i18n from '@/plugins/i18n';
import {
	iosTransitionAnimation,
	popoverEnterAnimation,
	popoverLeaveAnimation
} from '@rdlabo/ionic-theme-ios26';

// Types
import type { App } from 'vue';

export function registerPlugins(app: App) {
	// ios mode = real iOS device, or forced via ?ionic:mode=ios (dev/testing)
	const iosMode =
		isPlatform('ios') || new URLSearchParams(window.location.search).get('ionic:mode') === 'ios';

	app.use(IonicVue, {
		// iOS 26 (Liquid Glass) transitions from @rdlabo/ionic-theme-ios26
		navAnimation: iosMode ? iosTransitionAnimation : undefined,
		popoverEnter: iosMode ? popoverEnterAnimation : undefined,
		popoverLeave: iosMode ? popoverLeaveAnimation : undefined,
		// iOS 26 uses a chevron-only back pill; the text variant also grows
		// wide enough to overlap centered toolbar titles
		backButtonText: iosMode ? '' : undefined
	})
		.use(router)
		.use(pinia)
		.use(i18n);
}
