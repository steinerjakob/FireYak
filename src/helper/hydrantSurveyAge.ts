export const hydrantSurveyColors = {
	recent: '#16823d',
	older: '#e6ae00',
	stale: '#c62828',
	unknown: '#9333c8'
} as const;

export type HydrantSurveyAge = keyof typeof hydrantSurveyColors;

export const surveyRingIcons = ['hydrant', 'underground', 'wall', 'pump'] as const;

function monthsBefore(today: Date, months: number): number {
	const cutoff = new Date(today.getFullYear(), today.getMonth() - months + 1, 0);
	const day = Math.min(today.getDate(), cutoff.getDate());
	return cutoff.getFullYear() * 10000 + (cutoff.getMonth() + 1) * 100 + day;
}

export function hydrantSurveyAge(value: string | undefined, today = new Date()): HydrantSurveyAge {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'unknown';

	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	if (date.toISOString().slice(0, 10) !== value || year === 0) return 'unknown';

	const survey = year * 10000 + month * 100 + day;
	if (survey > monthsBefore(today, 0)) return 'unknown';
	if (survey > monthsBefore(today, 12)) return 'recent';
	return survey >= monthsBefore(today, 24) ? 'older' : 'stale';
}
