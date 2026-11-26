import { describe, expect, it } from 'vitest';
import { lastSurveyDate, parseSurveyDate, surveyAge, surveyBadge } from './surveyAge';

const today = new Date(2026, 10, 15); // 15 Nov 2026, local time

describe('parseSurveyDate', () => {
	it('reads full ISO days only', () => {
		expect(parseSurveyDate('2026-11-15')).toBe(20261115);
		expect(parseSurveyDate(' 2024-02-29 ')).toBe(20240229);
		for (const value of [undefined, '', '2026-11', '2026', '15.11.2026', '2026-11-15T10:00']) {
			expect(parseSurveyDate(value)).toBeNull();
		}
	});

	it('rejects impossible days', () => {
		for (const value of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '0000-01-01']) {
			expect(parseSurveyDate(value)).toBeNull();
		}
	});
});

describe('surveyAge', () => {
	const at = (date: string) => surveyAge({ 'survey:date': date }, today);

	it('buckets by local calendar day, both anniversaries in the middle band', () => {
		expect(at('2026-11-15')).toBe('recent');
		expect(at('2025-11-16')).toBe('recent');
		expect(at('2025-11-15')).toBe('older');
		expect(at('2024-11-15')).toBe('older');
		expect(at('2024-11-14')).toBe('stale');
		expect(at('1999-01-01')).toBe('stale');
	});

	it('has no age without a valid past date', () => {
		expect(surveyAge(undefined, today)).toBe('none');
		expect(surveyAge({}, today)).toBe('none');
		expect(at('2026-11-17')).toBe('none');
		expect(at('2026-02-29')).toBe('none');
		expect(at('2026-11')).toBe('none');
	});

	it('clamps anniversaries to the end of February', () => {
		const leapDay = new Date(2024, 1, 29);
		expect(surveyAge({ 'survey:date': '2023-02-28' }, leapDay)).toBe('older');
		expect(surveyAge({ 'survey:date': '2023-03-01' }, leapDay)).toBe('recent');
		expect(surveyAge({ 'survey:date': '2022-02-28' }, leapDay)).toBe('older');
		expect(surveyAge({ 'survey:date': '2022-02-27' }, leapDay)).toBe('stale');
	});

	it('accepts one day ahead for mappers in later time zones', () => {
		expect(at('2026-11-16')).toBe('recent');
		expect(surveyAge({ 'survey:date': '2027-01-01' }, new Date(2026, 11, 31))).toBe('recent');
		expect(surveyAge({ 'survey:date': '2027-01-02' }, new Date(2026, 11, 31))).toBe('none');
	});

	it('crosses year boundaries', () => {
		const january = new Date(2027, 0, 10);
		expect(surveyAge({ 'survey:date': '2026-01-11' }, january)).toBe('recent');
		expect(surveyAge({ 'survey:date': '2026-01-10' }, january)).toBe('older');
	});
});

describe('lastSurveyDate', () => {
	it('falls back to check_date and takes the newer of both', () => {
		expect(lastSurveyDate({ check_date: '2026-03-01' })).toBe(20260301);
		expect(lastSurveyDate({ 'survey:date': '2023-01-01', check_date: '2026-03-01' })).toBe(
			20260301
		);
		expect(lastSurveyDate({ 'survey:date': '2026-05-01', check_date: '2024-03-01' })).toBe(
			20260501
		);
		expect(lastSurveyDate({ 'survey:date': 'yes', check_date: '2024-03-01' })).toBe(20240301);
		expect(surveyAge({ 'survey:date': '2020-01-01', check_date: '2026-10-01' }, today)).toBe(
			'recent'
		);
	});
});

describe('surveyBadge', () => {
	it('badges water sources with a date, in service or not', () => {
		expect(surveyBadge({ emergency: 'fire_hydrant', 'survey:date': '2026-06-01' }, today)).toBe(
			'recent'
		);
		expect(surveyBadge({ emergency: 'suction_point', check_date: '2025-06-01' }, today)).toBe(
			'older'
		);
		expect(
			surveyBadge({ 'disused:emergency': 'fire_hydrant', 'survey:date': '2020-06-01' }, today)
		).toBe('stale');
		expect(surveyBadge({ emergency: 'water_tank', 'survey:date': '2026-06-01' }, today)).toBe(
			'recent'
		);
	});

	it('gives no badge without a date or to anything but a water source', () => {
		expect(surveyBadge({ emergency: 'fire_hydrant' }, today)).toBeNull();
		expect(surveyBadge({ emergency: 'fire_hydrant', 'survey:date': 'yes' }, today)).toBeNull();
		expect(surveyBadge({ amenity: 'fire_station', 'survey:date': '2026-06-01' }, today)).toBeNull();
		expect(surveyBadge(undefined, today)).toBeNull();
	});
});
