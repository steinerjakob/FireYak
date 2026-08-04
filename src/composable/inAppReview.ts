import { Capacitor } from '@capacitor/core';
import { InAppReview } from '@capacitor-community/in-app-review';
import { Preferences } from '@capacitor/preferences';

const ACTIVE_DAYS_KEY = 'review_active_days';
const AUTO_PROMPTED_KEY = 'review_auto_prompted';

/** Minimum unique active usage days before the one-shot auto-prompt fires. */
const ACTIVE_DAYS_THRESHOLD = 7;

/** Keeps the several trigger points from firing two review requests at once. */
let autoPromptInFlight = false;

/**
 * Returns today's date as `YYYY-MM-DD` in the user's local timezone.
 * Not `toISOString()`: that rolls the day over at UTC midnight, filing
 * evening usage under the neighbouring day.
 */
const getTodayString = (): string => {
	const now = new Date();
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	const day = `${now.getDate()}`.padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
};

/**
 * Reads the recorded active days. Never throws: this runs in the startup
 * path, where a corrupt value would abort everything queued behind it.
 */
const readActiveDays = async (): Promise<string[]> => {
	try {
		const { value } = await Preferences.get({ key: ACTIVE_DAYS_KEY });
		if (!value) return [];

		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];

		return parsed.filter((entry): entry is string => typeof entry === 'string');
	} catch (error) {
		console.warn('[InAppReview] Could not read active days, starting over:', error);
		return [];
	}
};

export function useInAppReview() {
	/** Whether the current platform supports the native in-app review dialog. */
	const isReviewAvailable = Capacitor.isNativePlatform();

	/**
	 * Records today as an active usage day, deduplicated by calendar day.
	 * Must be called on resume as well as on start — a mobile app is rarely
	 * cold started, so counting only mounts undercounts active days badly.
	 */
	const recordActiveDay = async (): Promise<void> => {
		if (!isReviewAvailable) return;

		const today = getTodayString();
		const days = await readActiveDays();
		if (days.includes(today)) return;

		days.push(today);

		try {
			await Preferences.set({
				key: ACTIVE_DAYS_KEY,
				// Days beyond the threshold carry no information — keep it bounded.
				value: JSON.stringify(days.slice(-ACTIVE_DAYS_THRESHOLD))
			});
		} catch (error) {
			console.warn('[InAppReview] Could not record active day:', error);
		}
	};

	/**
	 * Requests the native review dialog. Returns whether the request reached
	 * the OS — not whether a dialog was shown, which the OS decides by its own
	 * quota and never reports back.
	 */
	const requestReview = async (): Promise<boolean> => {
		if (!isReviewAvailable) return false;

		try {
			await InAppReview.requestReview();
			return true;
		} catch (error) {
			console.warn('[InAppReview] Review request failed:', error);
			return false;
		}
	};

	/**
	 * Requests the review dialog if the user is on native, has reached
	 * {@link ACTIVE_DAYS_THRESHOLD} active days, and has not been auto-prompted
	 * before. One-shot: once it reaches the OS it never auto-prompts again.
	 */
	const tryAutoPrompt = async (): Promise<void> => {
		if (!isReviewAvailable || autoPromptInFlight) return;

		autoPromptInFlight = true;
		try {
			const { value: alreadyPrompted } = await Preferences.get({ key: AUTO_PROMPTED_KEY });
			if (alreadyPrompted === 'true') return;

			const days = await readActiveDays();
			if (days.length < ACTIVE_DAYS_THRESHOLD) return;

			// Only burn the one-shot once the request reached the OS, so a failed
			// call stays retryable instead of losing the prompt for good.
			if (!(await requestReview())) return;

			await Preferences.set({
				key: AUTO_PROMPTED_KEY,
				value: 'true'
			});
		} catch (error) {
			console.warn('[InAppReview] Auto-prompt failed:', error);
		} finally {
			autoPromptInFlight = false;
		}
	};

	// `requestReview` stays unexported on purpose: a "Rate this app" button
	// wired to it does nothing once the store quota is spent, which is why
	// there isn't one. Eligibility is only ever decided by `tryAutoPrompt`.
	return {
		isReviewAvailable,
		recordActiveDay,
		tryAutoPrompt
	};
}
