// Register logic (GRS-17): the literal expected examples at the parity clock, the corrected defects (S-deadlines_tab-2
// and S-ics calendar format, S-overview-1 billed flag, S-csv), and v5's countdown, value and entry rules.
process.env.TZ = 'UTC';
import { describe, expect, it } from 'vitest';
import { REGISTERS } from '../../src/lib/views/registers/defs';
import { byDate, countdown, daysUntil, deadlineCalendar, entryFrom, foldLine, icsText, invalidReason, isBilled, isSkipped, openDeadlines, registerCsv, timesheetValue, unbilledHours, unsavable, type Row } from '../../src/lib/views/registers/logic';
import { seededUserWork } from '../../scripts/parity/lib/sweeps.mjs';

const CLOCK = new Date('2026-10-08T09:00:00Z');
const row = (rowId: string, values: Record<string, string>): Row => ({ rowId, values });

describe('deadline countdown at the fixed clock (expected example deadline-countdown-fixed-clock)', () => {
	// stored order E, A, C, D, B
	const stored = [['E', '2026-10-16'], ['A', '2026-10-01'], ['C', '2026-10-08'], ['D', '2026-10-15'], ['B', '2026-10-07']].map(([t, d]) => row(t!, { title: `Synthetic ${t}`, date: d!, cat: 'Filing', note: '' }));
	it('orders by date and shows v5 countdown text and tone', () => {
		const shown = byDate(stored).map((r) => [r.values.title, countdown(r.values.date!, CLOCK)]);
		expect(shown).toEqual([
			['Synthetic A', { text: '7d ago', tone: 'muted' }],
			['Synthetic B', { text: '1d ago', tone: 'muted' }],
			['Synthetic C', { text: 'today', tone: 'danger' }],
			['Synthetic D', { text: 'in 7d', tone: 'warning' }],
			['Synthetic E', { text: 'in 8d', tone: 'success' }],
		]);
	});
	it('shows a dash without a date and counts open deadlines from today on', () => {
		expect(countdown('', CLOCK)).toEqual({ text: '—', tone: 'muted' });
		expect(daysUntil('', CLOCK)).toBeNull();
		expect(openDeadlines(stored, CLOCK)).toBe(3);
	});
	it('keeps stored order for equal dates and puts undated deadlines first', () => {
		const r = byDate([row('1', { date: '2026-10-09' }), row('2', { date: '' }), row('3', { date: '2026-10-09' })]);
		expect(r.map((x) => x.rowId)).toEqual(['2', '1', '3']);
	});
});

describe('the overview tiles on the seeded synthetic user work', () => {
	const seeded = seededUserWork(CLOCK.toISOString());
	it('counts yesterday as past and today, tomorrow and later as open (v5: 3)', () => {
		expect(openDeadlines(seeded.ess_dcs_deadlines_v1.map((d: Record<string, string>, i: number) => row(String(i), d)), CLOCK)).toBe(3);
	});
	it("counts 'no' as unbilled (S-overview-1: v5 shows 2.5 h, the corrected app 3.5 h)", () => {
		expect(unbilledHours(seeded.ess_dcs_timesheet_v1.map((d: Record<string, string>, i: number) => row(String(i), d)))).toBe('3.5 h');
		expect([isBilled(''), isBilled('no'), isBilled('yes'), isBilled(' Yes ')]).toEqual([false, false, true, true]);
		expect(unbilledHours([])).toBe('0.0 h');
	});
});

describe('timesheet value (hours × rate in exact cents, S-timesheet_tab-3)', () => {
	it('multiplies parsed hours and rate, 0 for a missing part as v5, and nothing for a part that does not parse', () => {
		expect(timesheetValue({ hours: '2.5', rate: '1200' })).toBe('R 3 000.00');
		expect(timesheetValue({ hours: '', rate: '1000' })).toBe('R 0.00');
		expect(timesheetValue({ hours: 'Synthetic entry 1', rate: 'x' })).toBe('');
	});
});

describe('entries', () => {
	const ts = REGISTERS.timesheet_tab, dl = REGISTERS.deadlines_tab, pv = REGISTERS.privilege_tab;
	it('ignores an Add with every field empty, and a deadline without title or date', () => {
		expect(isSkipped(pv, entryFrom(pv, {}))).toBe(true);
		expect(isSkipped(pv, entryFrom(pv, { basis: 'Other' }))).toBe(false);
		expect(isSkipped(dl, entryFrom(dl, { title: 'x', cat: 'Filing' }))).toBe(true);
		expect(isSkipped(dl, entryFrom(dl, { title: 'x', date: '2026-10-09', cat: 'Filing' }))).toBe(false);
	});
	it('says why Save stores nothing: silent for an empty Add (v5), a message for an emptied Edit or a deadline without title or date (D13)', () => {
		const pp = REGISTERS.popia_tab;
		expect(unsavable(pp, entryFrom(pp, {}), false)).toBe('');
		expect(unsavable(pp, entryFrom(pp, {}), true)).toMatch(/cannot be saved empty.*use Delete/);
		expect(unsavable(pp, entryFrom(pp, { activity: 'x' }), true)).toBeNull();
		expect(unsavable(dl, entryFrom(dl, { cat: 'Filing' }), false)).toBe('');
		expect(unsavable(dl, entryFrom(dl, { title: 'x', cat: 'Filing' }), false)).toBe('Title and Date must be filled in; nothing was saved. Your input is kept.');
		expect(unsavable(dl, entryFrom(dl, { date: '2026-10-09', cat: 'Hearing' }), true)).toMatch(/^Title and Date must be filled in/);
		expect(unsavable(dl, entryFrom(dl, { cat: 'Hearing' }), true)).toMatch(/use Delete/);
		expect(unsavable(dl, entryFrom(dl, { title: 'x', date: '2026-10-09', cat: 'Filing' }), false)).toBeNull();
	});
	it('keeps values as typed and refuses values the form cannot produce', () => {
		expect(entryFrom(ts, { hours: ' 2,5 ', other: 'x', rate: 7 })).toEqual({ date: '', fee_earner: '', activity: '', hours: ' 2,5 ', rate: '', billed: '' });
		expect(invalidReason(ts, entryFrom(ts, { billed: 'maybe' }))).toMatch(/Billed\?/);
		expect(invalidReason(ts, entryFrom(ts, { date: '2026-02-30' }))).toMatch(/Date/);
		expect(invalidReason(dl, entryFrom(dl, { title: 'x', date: '2026-10-09', cat: '' }))).toMatch(/Category/);
		expect(invalidReason(ts, entryFrom(ts, { date: '2026-10-09', billed: 'no' }))).toBeNull();
		// a submitted textarea's CRLF (multipart and urlencoded alike) is stored as the LF the user typed
		expect(entryFrom(REGISTERS.annotations_tab, { note: 'one\r\ntwo\rthree\nfour', ref: 'a\r\nb' })).toEqual({ ref: 'a\r\nb', date: '', note: 'one\ntwo\nthree\nfour' });
	});
	it("carries no v5 browser storage key: a later v5 import derives the keys from v5's data (D16)", () => {
		for (const d of Object.values(REGISTERS)) expect(Object.keys(d)).not.toContain('v5Key');
	});
});

describe('CSV export (S-csv)', () => {
	it('writes the field keys, then each row in stored order, neutralising formulas and quoting CR and LF', () => {
		const csv = registerCsv(REGISTERS.annotations_tab, [row('a', { ref: '=HYPERLINK("x")', date: '2026-10-01', note: 'line one\nline two' }), row('b', { ref: '+1', date: '', note: 'cr\ronly' }), row('c', { ref: 'SD-010', date: '', note: '@sum' })]);
		expect(csv).toBe(`ref,date,note\r\n"'=HYPERLINK(""x"")",2026-10-01,"line one\nline two"\r\n'+1,,"cr\ronly"\r\nSD-010,,'@sum`);
	});
	it('matches v5 for the privilege example (ledger-privilege-add-add-delete header and row)', () => {
		expect(registerCsv(REGISTERS.privilege_tab, [row('a', { ref: 'OD-001', date: '', desc: '', basis: 'Litigation' })])).toBe('ref,date,desc,basis\r\nOD-001,,,Litigation');
	});
	it('writes a validated credit as a plain number, so a spreadsheet total includes it (GRS-49)', () => {
		const csv = registerCsv(REGISTERS.disbursements_tab, [row('a', { date: '2026-10-01', desc: 'Synthetic credit', payee: 'Synthetic payee', amount: '-500' }), row('b', { date: '2026-10-01', desc: 'Synthetic fee', payee: 'Synthetic payee', amount: 'R 1 000.00' })]);
		expect(csv).toBe('date,desc,payee,amount\r\n2026-10-01,Synthetic credit,Synthetic payee,-500.00\r\n2026-10-01,Synthetic fee,Synthetic payee,1000.00');
		expect(csv.split('\r\n').slice(1).reduce((sum, line) => sum + Number(line.split(',')[3]), 0)).toBe(500);
	});
	it.each([
		['=SUM(A1)', "'=SUM(A1)"], ['+SUM(A1)', "'+SUM(A1)"], ['@SUM(A1)', "'@SUM(A1)"], ['-500+1', "'-500+1"], ['-1e3', "'-1e3"], ['-5.001', "'-5.001"],
		['safe;=SUM(A1)', `"safe;'=SUM(A1)"`], ['safe\t=SUM(A1)', `"safe\t'=SUM(A1)"`], ['safe\r=SUM(A1)', `"safe\r'=SUM(A1)"`], ['safe\n=SUM(A1)', `"safe\n'=SUM(A1)"`],
		['-500; =1', `"'-500; '=1"`], ['', ''], ['   ', '   '],
	])('keeps %j protected (or blank) in every column, the amount included (GRS-49)', (value, cell) => {
		const d = REGISTERS.disbursements_tab;
		expect(registerCsv(d, [row('a', Object.fromEntries(d.fields.map((x) => [x.k, value])))])).toBe(`date,desc,payee,amount\r\n${[cell, cell, cell, cell].join(',')}`);
	});
	it('exempts only signed-money fields: text, hours and rates keep the apostrophe in every register (GRS-49)', () => {
		for (const d of Object.values(REGISTERS)) expect(registerCsv(d, [row('a', Object.fromEntries(d.fields.map((x) => [x.k, '-500'])))]).split('\r\n')[1]).toBe(d.fields.map((x) => (x.amount === 'signed-money' ? '-500.00' : "'-500")).join(','));
		expect(Object.values(REGISTERS).flatMap((d) => d.fields.filter((x) => x.amount === 'signed-money').map((x) => x.k))).toEqual(['amount']);
		expect(registerCsv(REGISTERS.timesheet_tab, [row('a', { date: '', fee_earner: 'Synthetic', activity: '-x', hours: '-1.5', rate: '-1200', billed: 'no' })])).toBe("date,fee_earner,activity,hours,rate,billed\r\n,Synthetic,'-x,'-1.5,'-1200,no");
	});
});

describe('calendar export (S-deadlines_tab-2, S-ics)', () => {
	const rows = [row('11111111-2222-4333-8444-555555555555', { title: 'File, plea; now \\ here\nnext', date: '2026-11-01', cat: 'Filing', note: '' }), row('undated', { title: 'x', date: '', cat: 'Other', note: '' }), row('66666666-7777-4888-9999-000000000000', { title: '', date: '2026-11-02', cat: 'Hearing', note: 'n' })];
	const ics = deadlineCalendar(rows, { now: CLOCK, productId: 'Synthetic v Case' });
	const lines = ics.split('\r\n');
	it('ends every line with CRLF and has no bare LF', () => {
		expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
	});
	it('writes the header with the case part of PRODID, or a neutral PRODID', () => {
		expect(lines.slice(0, 3)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic v Case//Workspace//EN']);
		expect(deadlineCalendar([], { now: CLOCK, productId: null })).toBe('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ClearCase//Deadlines//EN\r\nEND:VCALENDAR\r\n');
		expect(deadlineCalendar([], { now: CLOCK, productId: 'A, B; C' })).toContain('PRODID:-//A\\, B\\; C//Workspace//EN');
	});
	it('writes one event per dated deadline in stored order, with a stable UID, DTSTAMP from the clock and v5 DTSTART', () => {
		expect(lines.slice(3, 10)).toEqual(['BEGIN:VEVENT', 'UID:11111111-2222-4333-8444-555555555555@clearcase', 'DTSTAMP:20261008T090000Z', 'DTSTART:20261101T090000', 'SUMMARY:File\\, plea\\; now \\\\ here\\nnext', 'DESCRIPTION:Filing ', 'END:VEVENT']);
		expect(lines.slice(10, 17)).toEqual(['BEGIN:VEVENT', 'UID:66666666-7777-4888-9999-000000000000@clearcase', 'DTSTAMP:20261008T090000Z', 'DTSTART:20261102T090000', 'SUMMARY:Deadline', 'DESCRIPTION:Hearing n', 'END:VEVENT']);
		expect(ics).not.toContain('undated');
	});
	it('escapes TEXT and folds lines at 75 octets without splitting a character', () => {
		expect(icsText('a\\b;c,d\r\ne\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
		// D12: NEL, U+2028 and U+2029 are line breaks; every other control character but HTAB is removed
		expect(icsText('T1\u2028ATTENDEE:mailto:x@y.invalid')).toBe('T1\\nATTENDEE:mailto:x@y.invalid');
		expect(icsText('a\u0085b\u2029c\td')).toBe('a\\nb\\nc\td');
		expect(icsText('v\u000bf\u000cs\u001cn\u0000e\u001bd\u007fc\u0080\u009f!')).toBe('vfsnedc!');
		const ctl = deadlineCalendar([row('x', { title: 'a\u2028b\u000b', date: '2026-11-01', cat: 'Filing', note: 'n\u0085' })], { now: CLOCK, productId: null });
		expect(ctl).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]/);
		expect(ctl).toContain('SUMMARY:a\\nb\r\n');
		const long = `SUMMARY:${'é'.repeat(60)}`;
		const folded = foldLine(long).split('\r\n');
		for (const l of folded) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
		expect(folded.slice(1).every((l) => l.startsWith(' '))).toBe(true);
		expect(folded.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(long);
		expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75));
		expect(foldLine('x'.repeat(76)).split('\r\n')).toEqual(['x'.repeat(75), ' x']);
	});
});
