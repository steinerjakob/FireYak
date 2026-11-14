import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Preferences as an in-memory map.
const prefs = new Map<string, string>();
const writes: string[] = [];
vi.mock('@capacitor/preferences', () => ({
	Preferences: {
		get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
		set: async ({ key, value }: { key: string; value: string }) => {
			writes.push(`set ${key}=${value}`);
			prefs.set(key, value);
		},
		remove: async ({ key }: { key: string }) => {
			writes.push(`remove ${key}`);
			prefs.delete(key);
		}
	}
}));
vi.mock('@/composable/systemColorScheme', () => ({
	initSystemColorScheme: () => {},
	onSystemColorSchemeChange: () => {},
	systemPrefersDark: { value: false }
}));

// loadSettings applies the theme to <html>; Node has no DOM.
vi.stubGlobal('document', { documentElement: { classList: { toggle: () => {} } } });

const { useSettings } = await import('@/composable/settings');
const { useSettingsStore } = await import('@/store/settingsStore');

async function load(stored: Record<string, string>) {
	prefs.clear();
	writes.length = 0;
	for (const [k, v] of Object.entries(stored)) prefs.set(k, v);
	setActivePinia(createPinia());
	await useSettings().loadSettings();
	return useSettingsStore();
}

describe('loadSettings: hose routing migration (plan section 6.7, from phase 5)', () => {
	beforeEach(() => {
		prefs.clear();
	});

	it("clamp_hoses_to_roads = 'false' ends on optimized, written once, old key removed", async () => {
		const store = await load({ clamp_hoses_to_roads: 'false' });
		expect(store.hoseRouting).toBe('optimized');
		expect(prefs.get('hose_routing')).toBe('optimized');
		expect(prefs.has('clamp_hoses_to_roads')).toBe(false);
		expect(writes.filter((w) => w.includes('hose_routing') || w.includes('clamp'))).toEqual([
			'set hose_routing=optimized',
			'remove clamp_hoses_to_roads'
		]);
		// Second start: nothing left to migrate, nothing written.
		writes.length = 0;
		setActivePinia(createPinia());
		await useSettings().loadSettings();
		expect(useSettingsStore().hoseRouting).toBe('optimized');
		expect(writes.filter((w) => w.includes('hose_routing') || w.includes('clamp'))).toEqual([]);
	});

	it("clamp_hoses_to_roads = 'true' ends on roads", async () => {
		const store = await load({ clamp_hoses_to_roads: 'true' });
		expect(store.hoseRouting).toBe('roads');
		expect(store.clampHosesToRoads).toBe(true);
		expect(prefs.get('hose_routing')).toBe('roads');
		expect(prefs.has('clamp_hoses_to_roads')).toBe(false);
	});

	it("a stored 'direct' or an unknown value maps to optimized", async () => {
		for (const value of ['direct', 'terrain', '']) {
			const store = await load({ hose_routing: value });
			expect(store.hoseRouting).toBe('optimized');
			expect(prefs.get('hose_routing')).toBe('optimized');
		}
	});

	it('a fresh install gets optimized', async () => {
		const store = await load({});
		expect(store.hoseRouting).toBe('optimized');
		expect(store.clampHosesToRoads).toBe(false);
	});

	it('the toggle saves only hose_routing', async () => {
		await load({ hose_routing: 'optimized' });
		writes.length = 0;
		await useSettings().saveHoseRouting('roads');
		expect(writes).toEqual(['set hose_routing=roads']);
	});
});

describe('one-time cross-country note', () => {
	it('is not seen on a fresh install, persists once seen, stays seen after a restart', async () => {
		const first = await load({});
		expect(first.crossCountryNoteSeen).toBe(false);
		await useSettings().saveCrossCountryNoteSeen();
		expect(first.crossCountryNoteSeen).toBe(true);
		expect(prefs.get('cross_country_note_seen')).toBe('true');
		setActivePinia(createPinia());
		await useSettings().loadSettings();
		expect(useSettingsStore().crossCountryNoteSeen).toBe(true);
	});
});
