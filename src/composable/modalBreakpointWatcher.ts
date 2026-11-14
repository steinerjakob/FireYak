import { onMounted, onUnmounted, provide, type Ref } from 'vue';
import type { IonModal } from '@ionic/vue';

/** Template ref of an `<ion-modal>`: the component instance exposes its root element as `$el`. */
type IonModalElement = {
	addEventListener(type: string, listener: (event: CustomEvent<any>) => void): void;
	removeEventListener(type: string, listener: (event: CustomEvent<any>) => void): void;
};
type IonModalRef = { $el?: IonModalElement } | undefined;
import { useDefaultStore } from '@/store/defaultStore';
import { ROUTE_SHEET_KEY } from '@/composable/routeDetails';
import { sheetGrowTarget } from '@/helper/routeDetails';

export function useIonModalBreakpoint(
	modalRef: Ref<typeof IonModal | IonModalRef>,
	initialBreakpoint = 0.4
) {
	const defaultStore = useDefaultStore();

	const attachListeners = () => {
		const el = (modalRef.value as IonModalRef)?.$el;
		if (!el) return;

		const handleDidPresent = () => {
			defaultStore.bottomModalBreakpointValue(initialBreakpoint);
		};

		const handleBreakpointChange = (event: CustomEvent<any>) => {
			defaultStore.bottomModalBreakpointValue(event.detail.breakpoint);
		};

		const handleDidDismiss = () => {
			defaultStore.bottomModalBreakpointValue(0);
		};

		el.addEventListener('ionModalWillPresent', handleDidPresent);
		el.addEventListener('ionBreakpointDidChange', handleBreakpointChange);
		el.addEventListener('ionModalDidDismiss', handleDidDismiss);

		// Cleanup function
		return () => {
			el.removeEventListener('ionModalWillPresent', handleDidPresent);
			el.removeEventListener('ionBreakpointDidChange', handleBreakpointChange);
			el.removeEventListener('ionModalDidDismiss', handleDidDismiss);
		};
	};

	onMounted(() => {
		const cleanup = attachListeners();
		if (cleanup) {
			onUnmounted(cleanup);
		}
	});
}

/** The sheet methods of an `<ion-modal>` element used to grow it. */
type IonSheetElement = {
	getCurrentBreakpoint(): Promise<number | undefined>;
	setCurrentBreakpoint(breakpoint: number): Promise<void>;
};

/**
 * Lets the route section inside a bottom sheet grow the sheet when it expands
 * (plan §6.8): provides {@link ROUTE_SHEET_KEY} with a `grow` that moves the
 * sheet to {@link sheetGrowTarget} of its breakpoints (never shrinks it).
 */
export function provideRouteSheet(
	modalRef: Ref<typeof IonModal | IonModalRef>,
	breakpoints: readonly number[]
) {
	provide(ROUTE_SHEET_KEY, {
		async grow() {
			const el = (modalRef.value as { $el?: Partial<IonSheetElement> } | undefined)?.$el;
			if (!el?.getCurrentBreakpoint || !el.setCurrentBreakpoint) return;
			const current = await el.getCurrentBreakpoint();
			if (current === undefined) return;
			const target = sheetGrowTarget(breakpoints, current);
			if (target !== null) await el.setCurrentBreakpoint(target);
		}
	});
}
