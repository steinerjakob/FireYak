import { Capacitor } from '@capacitor/core';
import { InAppReview } from '@capacitor-community/in-app-review';
import { Preferences } from '@capacitor/preferences';

const ACTIVE_DAYS_KEY = 'review_active_days';
const AUTO_PROMPTED_KEY = 'review_auto_prompted';

/** Minimum unique active usage days before the one-shot auto-prompt fires. */
const ACTIVE_DAYS_THRESHOLD = 7;

/**
 * Returns today's date as an ISO date string (YYYY-MM-DD) in the user's local timezone.
 */
const getTodayString = (): string => {
	return new Date().toISOString().split('T')[0];
};

export function useInAppReview() {
	/** Whether the current platform supports the native in-app review dialog. */
	const isReviewAvailable = Capacitor.isNativePlatform();

	/**
	 * Records today as an active usage day in Preferences.
	 * Deduplicates by calendar day — calling multiple times on the same day is safe.
	 */
	const recordActiveDay = async (): Promise<void> => {
		if (!isReviewAvailable) return;

		const today = getTodayString();
		const { value } = await Preferences.get({ key: ACTIVE_DAYS_KEY });
		const days: string[] = value ? JSON.parse(value) : [];

		if (!days.includes(today)) {
			days.push(today);
			await Preferences.set({
				key: ACTIVE_DAYS_KEY,
				value: JSON.stringify(days)
			});
		}
	};

	/**
	 * Checks auto-prompt conditions and requests the review dialog if eligible.
	 *
	 * This is a **one-shot** prompt: once fired, it sets a persistent flag and
	 * never auto-prompts again. The OS (iOS StoreKit / Android Play In-App Review)
	 * may still silently decline the request based on its own quotas.
	 *
	 * Conditions:
	 * 1. Running on a native platform (iOS or Android)
	 * 2. The one-shot auto-prompt has not yet been fired
	 * 3. The user has at least {@link ACTIVE_DAYS_THRESHOLD} unique active usage days
	 */
	const tryAutoPrompt = async (): Promise<void> => {
		if (!isReviewAvailable) return;

		// Check if we already auto-prompted
		const { value: alreadyPrompted } = await Preferences.get({ key: AUTO_PROMPTED_KEY });
		if (alreadyPrompted === 'true') return;

		// Check active days threshold
		const { value: daysValue } = await Preferences.get({ key: ACTIVE_DAYS_KEY });
		const days: string[] = daysValue ? JSON.parse(daysValue) : [];

		if (days.length < ACTIVE_DAYS_THRESHOLD) return;

		// All conditions met — request the review and mark as prompted
		try {
			await InAppReview.requestReview();
		} catch (error) {
			console.warn('[InAppReview] Auto-prompt failed:', error);
		}

		await Preferences.set({
			key: AUTO_PROMPTED_KEY,
			value: 'true'
		});
	};

	/**
	 * Directly requests the native in-app review dialog.
	 * Intended for manual triggers (e.g. "Rate this App" button).
	 *
	 * On native platforms, calls the OS review API. The OS may silently decline.
	 * On web, this is a no-op.
	 */
	const requestReview = async (): Promise<void> => {
		if (!isReviewAvailable) return;

		try {
			await InAppReview.requestReview();
		} catch (error) {
			console.warn('[InAppReview] Manual review request failed:', error);
		}
	};

	return {
		isReviewAvailable,
		recordActiveDay,
		tryAutoPrompt,
		requestReview
	};
}
