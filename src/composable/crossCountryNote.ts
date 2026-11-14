import { toastController } from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/store/settingsStore';
import { useSettings } from '@/composable/settings';
import { crossCountryNoteDue } from '@/helper/routeLabel';

/**
 * The one-time "check cross-country stretches on site" note (plan §6.8): shown
 * as a toast the first time a drawn hose line has an off-road stretch, then
 * never again. It is marked as seen in the store when shown (no second toast
 * in this session) and persisted when dismissed (tap or timeout).
 */
export function useCrossCountryNote() {
	const settingsStore = useSettingsStore();
	const { saveCrossCountryNoteSeen } = useSettings();
	const { t } = useI18n();

	/** Shows the note when it is due for a line with `offRoadMeters` off-road. */
	async function maybeShowCrossCountryNote(offRoadMeters: number): Promise<void> {
		if (!crossCountryNoteDue(offRoadMeters, settingsStore.crossCountryNoteSeen)) return;
		settingsStore.setCrossCountryNoteSeen(true);
		const toast = await toastController.create({
			message: t('route.crossCountryNote'),
			duration: 10_000,
			position: 'top',
			buttons: [{ text: t('route.ok'), role: 'cancel' }]
		});
		void toast.onDidDismiss().then(() => saveCrossCountryNoteSeen());
		await toast.present();
	}

	return { maybeShowCrossCountryNote };
}
