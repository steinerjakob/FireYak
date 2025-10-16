import { ref, onMounted, onUnmounted } from 'vue';

export function useDarkMode() {
	const isDarkMode = ref(false);

	let mediaQuery: MediaQueryList | null = null;

	const updateDarkMode = (e: MediaQueryListEvent | MediaQueryList) => {
		isDarkMode.value = e.matches;
	};

	onMounted(() => {
		mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		isDarkMode.value = mediaQuery.matches;
		mediaQuery.addEventListener('change', updateDarkMode);
	});

	onUnmounted(() => {
		mediaQuery?.removeEventListener('change', updateDarkMode);
	});

	return { isDarkMode };
}
