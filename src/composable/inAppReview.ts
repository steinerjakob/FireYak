import { Capacitor } from '@capacitor/core';
import { InAppReview } from '@capacitor-community/in-app-review';
import { Preferences } from '@capacitor/preferences';

const ACTIVE_DAYS_KEY = 'review_active_days';
const AUTO_PROMPTED_KEY = 'review_auto_prompted';

/** Minimum unique active usage days before the one-shot auto-prompt fires. */
const ACTIVE_DAYS_THRESHOLD = 7;

/**
 * The auto-prompt can be attempted from several places (app start, app resume,
 * after a successful edit). Only one attempt may be in flight at a time so a
 * resume that races with a save cannot fire two review requests.
 */
let autoPromptInFlight = false;

/**
 * Returns today's date as `YYYY-MM-DD` in the user's local timezone.
 *
 * Deliberately not `toISOString()`: that converts to UTC first, so for anyone
 * east or west of UTC the "day" would roll over at the wrong local time and
 * evening (or early morning) usage would be filed under the neighbouring day.
 */
const getTodayString = (): string => {
	const now = new Date();
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	const day = `${now.getDate()}`.padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
};

/**
 * Reads the recorded active days, tolerating a missing or corrupt payload.
 *
 * This runs inside the app's startup path, so it must never throw — a bad
 * value would otherwise abort everything queued behind it.
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
	 * Records today as an active usage day in Preferences.
	 *
	 * Deduplicates by calendar day, so calling it on every app start *and*
	 * every resume is safe — and necessary: a mobile app is usually resumed
	 * from the background rather than cold started, so counting only cold
	 * starts would undercount active days badly.
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
				// Older days carry no information once the threshold is reached,
				// so the list stays bounded instead of growing for the app's
				// whole lifetime.
				value: JSON.stringify(days.slice(-ACTIVE_DAYS_THRESHOLD))
			});
		} catch (error) {
			console.warn('[InAppReview] Could not record active day:', error);
		}
	};

	/**
	 * Requests the native in-app review dialog.
	 *
	 * Returns whether the request reached the OS — not whether a dialog was
	 * shown. Both platforms decide that themselves and give no feedback:
	 * iOS allows at most 3 prompts per 365 days, Android has its own quota,
	 * and neither shows anything in a debug build (iOS) or in a build that was
	 * not installed from Play (Android).
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
	 * Checks auto-prompt conditions and requests the review dialog if eligible.
	 *
	 * This is a **one-shot** prompt: once it reaches the OS it sets a persistent
	 * flag and never auto-prompts again.
	 *
	 * Conditions:
	 * 1. Running on a native platform (iOS or Android)
	 * 2. The one-shot auto-prompt has not yet been fired
	 * 3. The user has at least {@link ACTIVE_DAYS_THRESHOLD} unique active usage days
	 */
	const tryAutoPrompt = async (): Promise<void> => {
		if (!isReviewAvailable || autoPromptInFlight) return;

		autoPromptInFlight = true;
		try {
			const { value: alreadyPrompted } = await Preferences.get({ key: AUTO_PROMPTED_KEY });
			if (alreadyPrompted === 'true') return;

			const days = await readActiveDays();
			if (days.length < ACTIVE_DAYS_THRESHOLD) return;

			// Only burn the one-shot once the request actually reached the OS.
			// A failed call (plugin missing, Play Services unavailable) must stay
			// retryable, otherwise the single automatic prompt is lost for good.
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

	// `requestReview` is deliberately not exported. There is no manual "Rate this
	// App" button by design: a button wired to the native dialog does nothing
	// most of the time, because both stores silently drop the request once their
	// quota is spent. The dialog is only ever asked for through `tryAutoPrompt`,
	// which enforces the eligibility rules.
	return {
		isReviewAvailable,
		recordActiveDay,
		tryAutoPrompt
	};
}
