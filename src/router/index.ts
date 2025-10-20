import { createRouter, createWebHashHistory } from '@ionic/vue-router';
import AboutView from '@/views/AboutView.vue';
import HomeView from '@/views/HomeView.vue';

const routes = [
	{
		path: '/',
		component: HomeView,
		children: [
			{
				path: '',
				name: 'Map',
				// route level code-splitting
				// this generates a separate chunk (Home-[hash].js) for this route
				// which is lazy-loaded when the route is visited.
				component: HomeView
			},
			{
				path: '/markers/:markerId',
				name: 'Selected marker',
				// route level code-splitting
				// this generates a separate chunk (Home-[hash].js) for this route
				// which is lazy-loaded when the route is visited.
				component: HomeView
			},
			{
				path: '/supplyPipe',
				name: 'Supply pipe calculation',
				// route level code-splitting
				// this generates a separate chunk (Home-[hash].js) for this route
				// which is lazy-loaded when the route is visited.
				component: HomeView
			}
		]
	},
	{
		path: '/about',
		name: 'about',
		component: AboutView
	}
];

const router = createRouter({
	history: createWebHashHistory(process.env.BASE_URL),
	routes
});

export default router;
