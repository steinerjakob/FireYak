import { Capacitor } from '@capacitor/core';
import { InAppReview } from '@capacitor-community/in-app-review';
import { Preferences } from '@capacitor/preferences';
import { useWhatsNew } from '@/composable/whatsNew';

const ACTIVE_DAYS_KEY = 'review_active_days';
const AUTO_PROMPTED_KEY = 'review_auto_prompted';

/** Minimum unique active usage days before the one-shot auto-prompt fires. */
const ACTIVE_DAYS_THRESHOLD = 7;

/** Lets the session settle first — at app start the map is still loading. */
const DEFAULT_PROMPT_DELAY_MS = 8000;

/** Matches the `YYYY-MM-DD` keys written by {@link getTodayString}. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Keeps the several trigger points from firing two review requests at once. */
let autoPromptInFlight = false;

/**
 * Set as soon as a request reaches the OS, so a failed `Preferences` write
 * cannot let another trigger ask again before the next launch.
 */
let autoPromptedThisSession = false;

/** The single pending attempt; module-level so any trigger point can cancel it. */
let promptTimer: ReturnType<typeof setTimeout> | undefined;

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

		// Unique, well-formed keys only: the threshold counts *distinct* days,
		// so junk in the stored array must not be able to satisfy it.
		return [
			...new Set(
				parsed.filter(
					(entry): entry is string => typeof entry === 'string' && DAY_KEY_PATTERN.test(entry)
				)
			)
		];
	} catch (error) {
		console.warn('[InAppReview] Could not read active days, starting over:', error);
		return [];
	}
};

export function useInAppReview() {
	/** Whether the current platform supports the native in-app review dialog. */
	const isReviewAvailable = Capacitor.isNativePlatform();

	const { isOpen: isWhatsNewOpen } = useWhatsNew();

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
		if (!isReviewAvailable || autoPromptInFlight || autoPromptedThisSession) return;

		// What's New wins: don't stack a rating dialog on top of release notes.
		// Checked here rather than at schedule time, since the modal may still be
		// open when the timer fires.
		if (isWhatsNewOpen.value) return;

		autoPromptInFlight = true;
		try {
			const { value: alreadyPrompted } = await Preferences.get({ key: AUTO_PROMPTED_KEY });
			if (alreadyPrompted === 'true') return;

			const days = await readActiveDays();
			if (days.length < ACTIVE_DAYS_THRESHOLD) return;

			// Only burn the one-shot once the request reached the OS, so a failed
			// call stays retryable instead of losing the prompt for good.
			if (!(await requestReview())) return;

			autoPromptedThisSession = true;
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

	/** Cancels a pending attempt — call when the app goes inactive or unmounts. */
	const cancelAutoPrompt = (): void => {
		clearTimeout(promptTimer);
		promptTimer = undefined;
	};

	/**
	 * Queues an attempt after `delayMs`, replacing any pending one. Every
	 * trigger point goes through here so a single `cancelAutoPrompt()` can stop
	 * whatever is outstanding.
	 */
	const scheduleAutoPrompt = (delayMs = DEFAULT_PROMPT_DELAY_MS): void => {
		if (!isReviewAvailable) return;

		cancelAutoPrompt();
		promptTimer = setTimeout(() => void tryAutoPrompt(), delayMs);
	};

	// `requestReview` stays unexported on purpose: a "Rate this app" button
	// wired to it does nothing once the store quota is spent, which is why
	// there isn't one. Eligibility is only ever decided by `tryAutoPrompt`.
	return {
		isReviewAvailable,
		recordActiveDay,
		scheduleAutoPrompt,
		cancelAutoPrompt
	};
}
