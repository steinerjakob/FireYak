import { ScreenOrientation, ScreenOrientationResult } from '@capacitor/screen-orientation';
import { ref } from 'vue';

const orientation = ref<ScreenOrientationResult>();

ScreenOrientation.addListener('screenOrientationChange', (currOrientation) => {
	orientation.value = currOrientation;
});

export function useScreenOrientation() {
	const getOrientation = ScreenOrientation.orientation();
	return { orientation, getOrientation };
}
