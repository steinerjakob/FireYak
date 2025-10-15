// Plugins
import router from '@/router';
import { registerPlugins } from '@/plugins';

/* Core CSS required for Ionic components to work properly */
import '@ionic/vue/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/vue/css/normalize.css';
import '@ionic/vue/css/structure.css';
import '@ionic/vue/css/typography.css';

/* Optional CSS utils that can be commented out */
import '@ionic/vue/css/padding.css';
import '@ionic/vue/css/float-elements.css';
import '@ionic/vue/css/text-alignment.css';
import '@ionic/vue/css/text-transformation.css';
import '@ionic/vue/css/flex-utils.css';
import '@ionic/vue/css/display.css';

import '@ionic/vue/css/palettes/dark.system.css';

// Components
import App from './App.vue';

// Composables
import { createApp } from 'vue';
import { enableEdge2Edge } from '@/plugins/edge2Edge';

const app = createApp(App);

registerPlugins(app);

router.isReady().then(() => {
	app.mount('#app');
	enableEdge2Edge();
});
