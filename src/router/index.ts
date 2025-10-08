import { createRouter, createWebHistory } from '@ionic/vue-router';

const routes = [
	{
		path: '/',
		component: () => import('@/views/HomeView.vue'),
		children: [
			{
				path: '',
				name: 'Map',
				// route level code-splitting
				// this generates a separate chunk (Home-[hash].js) for this route
				// which is lazy-loaded when the route is visited.
				component: () => import('@/views/HomeView.vue')
			},
			{
				path: '/markers/:markerId',
				name: 'Selected marker',
				// route level code-splitting
				// this generates a separate chunk (Home-[hash].js) for this route
				// which is lazy-loaded when the route is visited.
				component: () => import('@/views/HomeView.vue')
			}
		]
	}
];

const router = createRouter({
	history: createWebHistory(process.env.BASE_URL),
	routes
});

export default router;
