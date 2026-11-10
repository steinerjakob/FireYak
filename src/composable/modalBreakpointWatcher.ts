import { onMounted, onUnmounted, type Ref } from 'vue';
import type { IonModal } from '@ionic/vue';

/** Template ref of an `<ion-modal>`: the component instance exposes its root element as `$el`. */
type IonModalElement = {
	addEventListener(type: string, listener: (event: CustomEvent<any>) => void): void;
	removeEventListener(type: string, listener: (event: CustomEvent<any>) => void): void;
};
type IonModalRef = { $el?: IonModalElement } | undefined;
import { useDefaultStore } from '@/store/defaultStore';

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
