import { ScreenOrientation, ScreenOrientationResult } from '@capacitor/screen-orientation';
import { ref, watch } from 'vue';

const orientation = ref<ScreenOrientationResult>();

ScreenOrientation.addListener('screenOrientationChange', (currOrientation) => {
	orientation.value = currOrientation;
});

export function useScreenOrientation() {
	const getOrientation = ScreenOrientation.orientation();
	const isMobile = ref(window.innerWidth < 768);

	watch(orientation, () => {
		isMobile.value = window.innerWidth < 768;
	});

	return { orientation, getOrientation, isMobile };
}
