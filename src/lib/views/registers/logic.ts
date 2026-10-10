// Pure register logic (GRS-17): entries from form input, deadline countdowns and order, timesheet value and the
// overview totals, CSV and iCalendar export. v5 semantics are kept except where a source defect is corrected
// (S-deadlines_tab-1 delete by row id, S-overview-1 / S-timesheet_tab-1 billed flag, S-deadlines_tab-2 / S-ics calendar
// format, S-csv formula neutralisation, S-disbursements_tab-1 / S-timesheet_tab-3 amounts by the grammar in amounts.ts).
// Browser-safe; the clock is always passed in (callers use now()).
import { fmtR } from '../../components/format.ts';
import { toCSV, userCell } from '../../components/csv.ts';
import { parseAmount, twoDp, valueCents, hoursTile } from './amounts.ts';
import type { RegisterDef } from './defs.ts';

export type Entry = Record<string, string>;
/** The parts of a register definition the entry and export rules read (page data carries the same shape). */
export type Shape = Pick<RegisterDef, 'fields'> & { required?: readonly string[] | null };
/** A stored row as the views use it: its stable id and its v5-shaped string fields. */
export interface Row { rowId: string; values: Entry }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s: string) => { const [y, m, d] = s.split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d && m >= 1 && m <= 12; };

/** Every field of the register as text, from form input (a missing or non-text value is ''). */
export function entryFrom(def: Shape, input: Record<string, unknown>): Entry {
	return Object.fromEntries(def.fields.map((x) => { const v = input[x.k]; return [x.k, typeof v === 'string' ? v : ''] as const; }));
}

/**
 * Whether Add saves nothing, as v5 does silently: every field empty (ledgerAdd), or for the deadline tracker an empty
 * title or date (addDeadline). Edit uses the same rule, so an entry is never emptied into a blank row.
 */
export function isSkipped(def: Shape, e: Entry): boolean {
	return def.required ? def.required.some((k) => !e[k]) : def.fields.every((x) => !e[x.k]);
}

/**
 * Why Save stores nothing: '' for an Add with nothing typed, which v5 ignores silently (a select that always holds an
 * option does not count as typed); a message for an Edit emptied of every field, or an entry missing a required field
 * (a deadline's title or date), which v5 also ignored silently; null when the entry can be saved.
 */
export function unsavable(def: Shape, e: Entry, editing: boolean): string | null {
	const empty = def.fields.every((x) => !e[x.k] || (x.type === 'select' && x.placeholder === undefined));
	if (empty) return editing ? 'An entry cannot be saved empty, so nothing was changed. To remove the entry, use Delete.' : '';
	const missing = (def.required ?? []).filter((k) => !e[k]).map((k) => def.fields.find((x) => x.k === k)?.label ?? k);
	if (missing.length) return `${(def.required ?? []).map((k) => def.fields.find((x) => x.k === k)?.label ?? k).join(' and ')} must be filled in; nothing was saved. Your input is kept.`;
	return null;
}

/**
 * Why an entry cannot be stored, or null: a value the form cannot produce (v5's date inputs give '' or a date), or an
 * amount, rate or hours the grammar refuses (S-disbursements_tab-1, S-timesheet_tab-3). The typed text is kept.
 */
export function invalidReason(def: Shape, e: Entry): string | null {
	for (const x of def.fields) {
		const v = e[x.k] ?? '';
		if (x.type === 'date' && v !== '' && !(DATE.test(v) && realDate(v))) return `${x.label} must be a date (YYYY-MM-DD).`;
		if (x.type === 'select' && !(x.opts!.includes(v) || (x.placeholder !== undefined && v === ''))) return `${x.label} must be one of the listed options.`;
		if (x.amount) { const p = parseAmount(v, x.amount); if (p.kind === 'bad') return `${x.label} ${p.why}. Nothing was saved; your input is kept.`; }
	}
	return null;
}

// ---- deadlines ----------------------------------------------------------------------------------------------------

/**
 * v5 daysUntil: whole days from local midnight today to local midnight of the date; null without a date. Local time
 * as in v5 (S-deadlines_tab-4, low, copied): the server runs in its own timezone.
 */
export function daysUntil(date: string, now: Date): number | null {
	if (!date) return null;
	const t = new Date(`${date}T00:00:00`);
	const n = new Date(now.getTime());
	n.setHours(0, 0, 0, 0);
	return Math.round((t.getTime() - n.getTime()) / 86400000);
}

export type Tone = 'muted' | 'danger' | 'warning' | 'success' | 'info';
/** v5's countdown chip: '—', '<n>d ago', 'today', 'in <n>d' (warning within 7 days, success beyond). */
export function countdown(date: string, now: Date): { text: string; tone: Tone } {
	const du = daysUntil(date, now);
	if (du === null || Number.isNaN(du)) return { text: '—', tone: 'muted' };
	if (du < 0) return { text: `${-du}d ago`, tone: 'muted' };
	if (du === 0) return { text: 'today', tone: 'danger' };
	return { text: `in ${du}d`, tone: du <= 7 ? 'warning' : 'success' };
}

/** The table order: date ascending, undated first, ties in stored order (v5's stable sort of the store). */
export const byDate = <T extends Row>(rows: readonly T[]): T[] => [...rows].sort((a, b) => cmp(a.values.date ?? '', b.values.date ?? ''));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The overview's Open deadlines: dated deadlines not yet past (today counts), as v5 counts them. */
export const openDeadlines = (rows: readonly Row[], now: Date): number => rows.filter((r) => { const du = daysUntil(r.values.date ?? '', now); return du !== null && du >= 0; }).length;

// ---- timesheet ----------------------------------------------------------------------------------------------------

/**
 * The derived Value column: hours × rate in exact cents, rounded once half-up (S-timesheet_tab-3: v5 multiplied
 * parseFloat results); an empty part is 0 as in v5; '' when the hours or the rate does not parse (a stored row from a
 * restore or a v5 import), which the table flags as not counted.
 */
export const timesheetValue = (e: Entry): string => { const c = valueCents(e.hours ?? '', e.rate ?? ''); return c === null ? '' : fmtR(twoDp(c)); };

/**
 * Whether a time entry is billed. The Billed? select stores '' (left at its placeholder), 'no' or 'yes'; only 'yes'
 * is billed. v5 tested the string's truthiness, so 'no' counted as billed (S-overview-1, S-timesheet_tab-1).
 */
export const isBilled = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'yes';

/**
 * The overview's Unbilled time: the exact sum of every unbilled entry's hours, rounded once to one decimal, with ' h'
 * as v5 formats it; hours that do not parse are not counted (and counted in `uncounted`), never coerced.
 */
export function unbilledTime(rows: readonly Row[]): { value: string; uncounted: number } {
	let sum = 0n, uncounted = 0;
	for (const r of rows) {
		if (isBilled(r.values.billed)) continue;
		const h = parseAmount(r.values.hours ?? '', 'hours');
		if (h.kind === 'ok') sum += h.units;
		else if (h.kind === 'bad') uncounted++;
	}
	return { value: `${hoursTile(sum)} h`, uncounted };
}
export const unbilledHours = (rows: readonly Row[]): string => unbilledTime(rows).value;

// ---- table cells --------------------------------------------------------------------------------------------------

/** A cell's display text for the plain kinds (refs, countdowns and categories render as their own elements). */
export function cellText(kind: string, e: Entry, field: string | undefined): string {
	const v = field ? (e[field] ?? '') : '';
	if (kind === 'money') { const p = parseAmount(v, 'signed-money'); return p.kind === 'ok' ? fmtR(twoDp(p.units)) : v; }
	if (kind === 'value') return timesheetValue(e);
	if (kind === 'date-or-dash') return v || '—';
	if (kind === 'category') return v || 'Other';
	return v;
}

// ---- exports ------------------------------------------------------------------------------------------------------

/**
 * The register as v5's CSV: the field keys as the header, then every row in stored order. Every value is user-entered,
 * so each passes through userCell (formula neutralisation, S-csv); toCSV quotes a quote, comma, CR or LF.
 */
export const registerCsv = (def: Shape, rows: readonly Row[]): string =>
	toCSV([def.fields.map((x) => x.k), ...rows.map((r) => def.fields.map((x) => userCell(r.values[x.k] ?? '')))]);

/**
 * RFC 5545 TEXT: backslash, semicolon, comma and line breaks escaped; NEL, U+2028 and U+2029 are line breaks too, and
 * every other control character but HTAB is removed (TSAFE-CHAR excludes them).
 */
export const icsText = (s: string): string =>
	s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\\n').replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '');

/** RFC 5545 folding: lines longer than 75 octets continue on lines starting with a space, never inside a character. */
export function foldLine(line: string): string {
	const enc = new TextEncoder();
	const out: string[] = [];
	let cur = '', size = 0;
	for (const ch of line) {
		const n = enc.encode(ch).length;
		if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; size = 0; }
		cur += ch;
		size += n;
	}
	out.push(cur);
	return out.join('\r\n ');
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** v5's DTSTART form: the date at 09:00 floating local time. */
export const icsDate = (date: string) => `${date.replace(/-/g, '')}T090000`;
/** PRODID: the case part from the package's view-content data, or a neutral product id. */
export const icsProductId = (casePart: string | null) => (casePart ? `-//${icsText(casePart)}//Workspace//EN` : '-//ClearCase//Deadlines//EN');

/**
 * The deadline calendar (S-deadlines_tab-2, S-ics corrected): CRLF after every line, TEXT escaping, 75-octet folding,
 * DTSTAMP from the clock, a UID from the row's stable id (never its position), v5's DTSTART form, SUMMARY and
 * DESCRIPTION as v5 composes them. Every dated deadline in stored order, as v5 exports them.
 */
export function deadlineCalendar(rows: readonly Row[], { now, productId }: { now: Date; productId: string | null }): string {
	const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${icsProductId(productId)}`];
	for (const r of rows) {
		const e = r.values;
		if (!e.date) continue;
		lines.push('BEGIN:VEVENT', `UID:${r.rowId}@clearcase`, `DTSTAMP:${stamp(now)}`, `DTSTART:${icsDate(e.date)}`, `SUMMARY:${icsText(e.title || 'Deadline')}`, `DESCRIPTION:${icsText(`${e.cat || ''} ${e.note || ''}`)}`, 'END:VEVENT');
	}
	lines.push('END:VCALENDAR');
	return lines.map(foldLine).join('\r\n') + '\r\n';
}
