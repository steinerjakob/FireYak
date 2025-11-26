import { onMounted, onUnmounted, type Ref } from 'vue';
import type { IonModal } from '@ionic/vue';
import { useDefaultStore } from '@/store/defaultStore';

export function useIonModalBreakpoint(
	modalRef: Ref<typeof IonModal | undefined>,
	initialBreakpoint = 0.4
) {
	const defaultStore = useDefaultStore();

	const attachListeners = () => {
		const el = modalRef.value?.$el;
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

		el.addEventListener('ionModalDidPresent', handleDidPresent);
		el.addEventListener('ionBreakpointDidChange', handleBreakpointChange);
		el.addEventListener('ionModalDidDismiss', handleDidDismiss);

		// Cleanup function
		return () => {
			el.removeEventListener('ionModalDidPresent', handleDidPresent);
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
