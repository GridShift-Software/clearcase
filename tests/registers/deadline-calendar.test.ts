// A deadline's day count is the number of calendar days from today in the court's calendar (South Africa) to the
// deadline's date, whatever the host's time zone (GRS-174, S-deadlines_tab-4, IDR-289). v5 counted from the host's local
// midnight, so a host 25 hours away from another (Kiritimati UTC+14, Pago Pago UTC-11) showed a different count.
import { afterEach, describe, expect, it } from 'vitest';
import { countdown, daysUntil, openDeadlines, type Row } from '../../src/lib/views/registers/logic';

const HOSTS = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC', 'America/New_York', 'Europe/London', 'Africa/Johannesburg', 'Asia/Kolkata'];
const outer = process.env.TZ;
afterEach(() => { if (outer === undefined) delete process.env.TZ; else process.env.TZ = outer; });

// 23:59:59 on 15 January 2030 and 00:30 on 16 January 2030 in South Africa (UTC+2 all year)
const BEFORE = new Date('2030-01-15T21:59:59Z');
const AFTER = new Date('2030-01-15T22:30:00Z');
const row = (date: string): Row => ({ rowId: date, values: { title: 'Synthetic deadline', date, cat: 'Filing', note: '' } });

describe('deadline day counts near midnight in South Africa', () => {
	it.each(HOSTS)('counts on the South African calendar date whatever the host time zone (TZ=%s)', (tz) => {
		process.env.TZ = tz;
		expect([daysUntil('2030-01-15', BEFORE), daysUntil('2030-01-16', BEFORE)]).toEqual([0, 1]);
		expect([daysUntil('2030-01-15', AFTER), daysUntil('2030-01-16', AFTER), daysUntil('2030-01-17', AFTER)]).toEqual([-1, 0, 1]);
		expect(countdown('2030-01-16', BEFORE)).toEqual({ text: 'in 1d', tone: 'warning' });
		expect(countdown('2030-01-16', AFTER)).toEqual({ text: 'today', tone: 'danger' });
		expect(countdown('2030-01-15', AFTER)).toEqual({ text: '1d ago', tone: 'muted' });
		expect(openDeadlines(['2030-01-15', '2030-01-16', '2030-01-17'].map(row), BEFORE)).toBe(3);
		expect(openDeadlines(['2030-01-15', '2030-01-16', '2030-01-17'].map(row), AFTER)).toBe(2);
	});
});
