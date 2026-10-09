// Pure register logic (GRS-17): entries from form input, deadline countdowns and order, timesheet value and the
// overview totals, CSV and iCalendar export. v5 semantics are kept except where a source defect is corrected
// (S-deadlines_tab-1 delete by row id, S-overview-1 / S-timesheet_tab-1 billed flag, S-deadlines_tab-2 / S-ics calendar
// format, S-csv formula neutralisation). Browser-safe; the clock is always passed in (callers use now()).
import { fmtR, money } from '../../components/format.ts';
import { toCSV, userCell } from '../../components/csv.ts';
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

/** Why an entry cannot be stored (a value the form cannot produce), or null. v5's date inputs give '' or a date. */
export function invalidReason(def: Shape, e: Entry): string | null {
	for (const x of def.fields) {
		const v = e[x.k] ?? '';
		if (x.type === 'date' && v !== '' && !(DATE.test(v) && realDate(v))) return `${x.label} must be a date (YYYY-MM-DD).`;
		if (x.type === 'select' && !(x.opts!.includes(v) || (x.placeholder !== undefined && v === ''))) return `${x.label} must be one of the listed options.`;
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

/** v5's derived Value column: money(hours × rate), each parsed with parseFloat and 0 when not a number. */
export const timesheetValue = (e: Entry): string => fmtR((parseFloat(e.hours ?? '') || 0) * (parseFloat(e.rate ?? '') || 0));

/**
 * Whether a time entry is billed. The Billed? select stores '' (left at its placeholder), 'no' or 'yes'; only 'yes'
 * is billed. v5 tested the string's truthiness, so 'no' counted as billed (S-overview-1, S-timesheet_tab-1).
 */
export const isBilled = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'yes';

/** The overview's Unbilled time: the hours of every unbilled entry, one decimal and ' h', as v5 formats it. */
export const unbilledHours = (rows: readonly Row[]): string => `${rows.filter((r) => !isBilled(r.values.billed)).reduce((s, r) => s + (parseFloat(r.values.hours ?? '') || 0), 0).toFixed(1)} h`;

// ---- table cells --------------------------------------------------------------------------------------------------

/** A cell's display text for the plain kinds (refs, countdowns and categories render as their own elements). */
export function cellText(kind: string, e: Entry, field: string | undefined): string {
	const v = field ? (e[field] ?? '') : '';
	if (kind === 'money') return money(v);
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

/** RFC 5545 TEXT: backslash, semicolon, comma and line breaks escaped. */
export const icsText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

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
