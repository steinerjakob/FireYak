import { createRouter, createWebHashHistory } from '@ionic/vue-router';

const routes = [
	{
		path: '/',
		component: () => import('@/views/HomeView.vue'),
		children: [
			{
				path: '',
				name: 'Map',
				component: () => import('@/views/HomeView.vue')
			},
			{
				path: 'markers/:markerId',
				name: 'Selected marker',
				component: () => import('@/views/HomeView.vue')
			},
			{
				path: 'supplypipe',
				name: 'Supply pipe calculation',
				component: () => import('@/views/HomeView.vue')
			},
			{
				path: 'nearbysources',
				name: 'Nearby water source',
				component: () => import('@/views/HomeView.vue')
			},
			{
				path: 'nearbysources/:markerId',
				name: 'Nearby water source details',
				component: () => import('@/views/HomeView.vue')
			}
		]
	},
	{
		path: '/about',
		name: 'about',
		component: () => import('@/views/AboutView.vue')
	},
	{
		path: '/settings',
		name: 'Settings',
		component: () => import('@/views/SettingsView.vue')
	},
	{
		path: '/markerimages/:relatedId',
		name: 'markerimages',
		component: () => import('@/views/MarkerImageViewer.vue')
	}
];

const router = createRouter({
	history: createWebHashHistory(process.env.BASE_URL),
	routes
});

export default router;
