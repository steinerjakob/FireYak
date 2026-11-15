import { describe, expect, it } from 'vitest';
import { hydrantSurveyAge } from './hydrantSurveyAge';

describe('hydrantSurveyAge', () => {
	const today = new Date(2026, 10, 15);

	it('uses the local calendar day and includes both anniversaries in the yellow band', () => {
		expect(hydrantSurveyAge('2026-11-15', today)).toBe('recent');
		expect(hydrantSurveyAge('2025-11-16', today)).toBe('recent');
		expect(hydrantSurveyAge('2025-11-15', today)).toBe('older');
		expect(hydrantSurveyAge('2024-11-15', today)).toBe('older');
		expect(hydrantSurveyAge('2024-11-14', today)).toBe('stale');
	});

	it('treats missing, incomplete, impossible, and future dates as unknown', () => {
		for (const value of [undefined, '', '2026-11', '2026-02-29', '2026-11-16']) {
			expect(hydrantSurveyAge(value, today)).toBe('unknown');
		}
	});

	it('clamps anniversary cutoffs to the last day of February', () => {
		const leapDay = new Date(2024, 1, 29);
		expect(hydrantSurveyAge('2023-02-28', leapDay)).toBe('older');
		expect(hydrantSurveyAge('2022-02-28', leapDay)).toBe('older');
		expect(hydrantSurveyAge('2022-02-27', leapDay)).toBe('stale');
	});
});
