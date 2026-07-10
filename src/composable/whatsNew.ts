import { ref } from 'vue';
import { Preferences } from '@capacitor/preferences';
import { version as currentVersion } from '@/../package.json';
import whatsNewData from '@/assets/whats-new.json';

const LAST_SEEN_VERSION_KEY = 'whats_new_last_seen_version';

export type WhatsNewEntryType = 'feature' | 'improvement' | 'fix';

export interface WhatsNewEntry {
	type: WhatsNewEntryType;
	en: string;
	de: string;
}

export interface WhatsNewRelease {
	version: string;
	date: string;
	entries: WhatsNewEntry[];
}

const releases = (whatsNewData as { releases: WhatsNewRelease[] }).releases;

// This composable should be a singleton, so we define the state outside the
// function: the modal is opened from App.vue's startup check and re-opened
// from AboutView, and WhatsNewModal.vue reads the same instance.
const isOpen = ref(false);
const visibleReleases = ref<WhatsNewRelease[]>([]);

/** Splits "2.15.0-beta.1" into [2, 15, 0], ignoring any prerelease suffix. */
const parseVersion = (v: string): [number, number, number] => {
	const [core] = v.split('-');
	const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number(part) || 0);
	return [major, minor, patch];
};

/** Compares two versions like `Array#sort` comparators: negative, zero, positive. */
const compareVersions = (a: string, b: string): number => {
	const [aMajor, aMinor, aPatch] = parseVersion(a);
	const [bMajor, bMinor, bPatch] = parseVersion(b);
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	return aPatch - bPatch;
};

const sortNewestFirst = (list: WhatsNewRelease[]): WhatsNewRelease[] =>
	[...list].sort((a, b) => compareVersions(b.version, a.version));

export function useWhatsNew() {
	/**
	 * Compares the stored last-seen version against the running app version
	 * and, if any releases were skipped, prepares the modal with their
	 * entries (newest first). Call once on startup.
	 *
	 * - no stored version → never shown before: show the newest release with
	 *   entries as a feature overview (covers fresh installs and the first
	 *   update to a version that ships this feature).
	 * - stored < current → show entries for releases in (stored, current].
	 * - stored >= current → rollback/dev build: store current, don't show.
	 * - nothing to show (skipped releases had no entries) → still store current.
	 *
	 * Returns true when the modal will be shown this session — callers use
	 * this to skip the in-app review prompt for the session (What's New wins).
	 */
	const checkForUpdate = async (): Promise<boolean> => {
		const { value: storedVersion } = await Preferences.get({ key: LAST_SEEN_VERSION_KEY });

		if (!storedVersion) {
			const newest = sortNewestFirst(releases).find((release) => release.entries.length > 0);
			if (!newest) {
				await Preferences.set({ key: LAST_SEEN_VERSION_KEY, value: currentVersion });
				return false;
			}
			visibleReleases.value = [newest];
			isOpen.value = true;
			return true;
		}

		if (compareVersions(storedVersion, currentVersion) >= 0) {
			await Preferences.set({ key: LAST_SEEN_VERSION_KEY, value: currentVersion });
			return false;
		}

		const skipped = releases.filter(
			(release) =>
				release.entries.length > 0 &&
				compareVersions(release.version, storedVersion) > 0 &&
				compareVersions(release.version, currentVersion) <= 0
		);

		if (skipped.length === 0) {
			await Preferences.set({ key: LAST_SEEN_VERSION_KEY, value: currentVersion });
			return false;
		}

		visibleReleases.value = sortNewestFirst(skipped);
		isOpen.value = true;
		return true;
	};

	/** Opens the modal with the full bundled release history (About page link). */
	const openHistory = (): void => {
		visibleReleases.value = sortNewestFirst(releases);
		isOpen.value = true;
	};

	/** Closes the modal and stores the current version as seen. */
	const dismiss = async (): Promise<void> => {
		isOpen.value = false;
		await Preferences.set({ key: LAST_SEEN_VERSION_KEY, value: currentVersion });
	};

	return {
		isOpen,
		visibleReleases,
		checkForUpdate,
		openHistory,
		dismiss
	};
}
