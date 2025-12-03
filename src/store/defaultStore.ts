import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { Capacitor } from '@capacitor/core';
import { useScreenDetection } from '@/composable/screenDetection';

interface VisibleMapView {
	x: number;
	xMax: number;
	y: number;
	yMax: number;
	top: number;
	bottom: number;
}
export const useDefaultStore = defineStore('appDefault', () => {
	const visibleMapView = ref<VisibleMapView>({ x: 0, y: 0, top: 0, bottom: 0, xMax: 0, yMax: 0 });

	const { isMobile } = useScreenDetection();
	const fullHeight = Capacitor.isNativePlatform() ? window.screen.height : window.innerHeight;
	const fullWidth = Capacitor.isNativePlatform() ? window.screen.width : window.innerWidth;

	watch(isMobile, (mobile) => {
		if (mobile) {
			visibleMapView.value.x = 0;
		} else {
			visibleMapView.value.x = 420; // default width of the left panel inc margin
		}
	});

	const getSafeArea = () => {
		const docStyle = getComputedStyle(document.documentElement);
		visibleMapView.value.top = parseFloat(docStyle.getPropertyValue('--ion-safe-area-top')) || 0;
		visibleMapView.value.bottom =
			parseFloat(docStyle.getPropertyValue('--ion-safe-area-bottom')) || 0;
		visibleMapView.value.xMax = fullWidth;
		visibleMapView.value.yMax = fullHeight;
	};
	const bottomModalBreakpointValue = (value: number) => {
		visibleMapView.value.y = fullHeight * (1 - value);
		getSafeArea();
	};

	return { visibleMapView, bottomModalBreakpointValue };
});
