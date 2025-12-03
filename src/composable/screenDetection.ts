import { ref } from 'vue';

const isMobile = ref(window.innerWidth < 768);

const handleResize = () => {
	isMobile.value = window.innerWidth < 768;
};

window.addEventListener('resize', handleResize);

export function useScreenDetection() {
	return { isMobile };
}
