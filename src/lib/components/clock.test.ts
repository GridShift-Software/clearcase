import { afterEach, describe, expect, it } from 'vitest';
import { fixedNowSetting, now, parseFixedNow } from './clock.ts';

const saved = process.env.CLEARCASE_FIXED_NOW;
afterEach(() => { if (saved === undefined) delete process.env.CLEARCASE_FIXED_NOW; else process.env.CLEARCASE_FIXED_NOW = saved; });

describe('clock seam', () => {
	it('reads the real clock when CLEARCASE_FIXED_NOW is unset or empty', () => {
		for (const v of [undefined, '']) {
			if (v === undefined) delete process.env.CLEARCASE_FIXED_NOW; else process.env.CLEARCASE_FIXED_NOW = v;
			const t0 = Date.now();
			const t = now().getTime();
			expect(t).toBeGreaterThanOrEqual(t0);
			expect(t).toBeLessThanOrEqual(Date.now());
			expect(fixedNowSetting()).toBeNull();
		}
	});

	it('returns the fixed ISO-8601 instant when set, on every call', () => {
		process.env.CLEARCASE_FIXED_NOW = '2030-01-31T09:00:00Z';
		expect(now().toISOString()).toBe('2030-01-31T09:00:00.000Z');
		expect(now().toISOString()).toBe('2030-01-31T09:00:00.000Z');
		process.env.CLEARCASE_FIXED_NOW = '2030-01-31T11:30:00+02:00';
		expect(now().toISOString()).toBe('2030-01-31T09:30:00.000Z');
		process.env.CLEARCASE_FIXED_NOW = '2030-01-31';
		expect(now().toISOString()).toBe('2030-01-31T00:00:00.000Z');
	});

	it('fails loudly on a value that is not ISO-8601 with an offset, instead of using the real clock', () => {
		for (const bad of ['tomorrow', '31/01/2030', '2030-01-31T09:00:00', '2030-02-30T00:00:00Z', '1e12']) expect(() => parseFixedNow(bad), bad).toThrow(/CLEARCASE_FIXED_NOW/);
	});
});
