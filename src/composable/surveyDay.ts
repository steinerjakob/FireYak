import { readonly, ref } from 'vue';

/**
 * The local calendar day the survey-age badges (issue #120) are aged against,
 * shared by the map and the nearby list so both turn over together. It moves
 * on at local midnight (a one-off timer, re-armed each day) and, since timers
 * sleep with a backgrounded app, whenever the app comes back to the foreground
 * on a new day.
 */
const today = ref(new Date());
let timer: ReturnType<typeof setTimeout> | undefined;
let users = 0;

function check() {
	const now = new Date();
	if (now.toDateString() !== today.value.toDateString()) today.value = now;
	arm();
}

function arm() {
	clearTimeout(timer);
	const now = new Date();
	// A few seconds past midnight, so the new day has surely begun.
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
	timer = setTimeout(check, next.getTime() - now.getTime());
}

function onVisibilityChange() {
	if (!document.hidden) check();
}

/** Reactive "today" for survey ages; read `.value` inside a computed or watch. */
export const surveyToday = readonly(today);

/** Starts tracking the day (ref-counted); returns the matching stop. */
export function trackSurveyDay(): () => void {
	if (users++ === 0) {
		document.addEventListener('visibilitychange', onVisibilityChange);
		check();
	}
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		if (--users === 0) {
			document.removeEventListener('visibilitychange', onVisibilityChange);
			clearTimeout(timer);
			timer = undefined;
		}
	};
}
