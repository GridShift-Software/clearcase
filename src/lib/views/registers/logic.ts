import { fmtR } from '../../components/format.ts';
import { toCSV, userCell } from '../../components/csv.ts';
import { parseAmount, twoDp, valueCents, hoursTile } from './amounts.ts';
import type { RegisterDef } from './defs.ts';

export type Entry = Record<string, string>;
export type Shape = Pick<RegisterDef, 'fields'> & { required?: readonly string[] | null };
export interface Row { rowId: string; values: Entry }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s: string) => { const [y, m, d] = s.split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d && m >= 1 && m <= 12; };

/**
 * Every field of the register as text, from form input (a missing or non-text value is ''). A form submission sends a
 * textarea's line breaks as CRLF (multipart and urlencoded alike) while the textarea's own value holds LF, so a
 * textarea's CRLF or CR is stored as LF, as typed.
 */
export function entryFrom(def: Shape, input: Record<string, unknown>): Entry {
	return Object.fromEntries(def.fields.map((x) => { const v = input[x.k]; return [x.k, typeof v !== 'string' ? '' : x.type === 'textarea' ? v.replace(/\r\n?/g, '\n') : v] as const; }));
}

export function isSkipped(def: Shape, e: Entry): boolean {
	return def.required ? def.required.some((k) => !e[k]) : def.fields.every((x) => !e[x.k]);
}

export function unsavable(def: Shape, e: Entry, editing: boolean): string | null {
	const empty = def.fields.every((x) => !e[x.k] || (x.type === 'select' && x.placeholder === undefined));
	if (empty) return editing ? 'An entry cannot be saved empty, so nothing was changed. To remove the entry, use Delete.' : '';
	const missing = (def.required ?? []).filter((k) => !e[k]).map((k) => def.fields.find((x) => x.k === k)?.label ?? k);
	if (missing.length) return `${(def.required ?? []).map((k) => def.fields.find((x) => x.k === k)?.label ?? k).join(' and ')} must be filled in; nothing was saved. Your input is kept.`;
	return null;
}

export function invalidReason(def: Shape, e: Entry): string | null {
	for (const x of def.fields) {
		const v = e[x.k] ?? '';
		if (x.type === 'date' && v !== '' && !(DATE.test(v) && realDate(v))) return `${x.label} must be a date (YYYY-MM-DD).`;
		if (x.type === 'select' && !(x.opts!.includes(v) || (x.placeholder !== undefined && v === ''))) return `${x.label} must be one of the listed options.`;
		if (x.amount) { const p = parseAmount(v, x.amount); if (p.kind === 'bad') return `${x.label} ${p.why}. Nothing was saved; your input is kept.`; }
	}
	return null;
}


export function daysUntil(date: string, now: Date): number | null {
	if (!date) return null;
	const t = new Date(`${date}T00:00:00`);
	const n = new Date(now.getTime());
	n.setHours(0, 0, 0, 0);
	return Math.round((t.getTime() - n.getTime()) / 86400000);
}

export type Tone = 'muted' | 'danger' | 'warning' | 'success' | 'info';
export function countdown(date: string, now: Date): { text: string; tone: Tone } {
	const du = daysUntil(date, now);
	if (du === null || Number.isNaN(du)) return { text: '—', tone: 'muted' };
	if (du < 0) return { text: `${-du}d ago`, tone: 'muted' };
	if (du === 0) return { text: 'today', tone: 'danger' };
	return { text: `in ${du}d`, tone: du <= 7 ? 'warning' : 'success' };
}

export const byDate = <T extends Row>(rows: readonly T[]): T[] => [...rows].sort((a, b) => cmp(a.values.date ?? '', b.values.date ?? ''));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const openDeadlines = (rows: readonly Row[], now: Date): number => rows.filter((r) => { const du = daysUntil(r.values.date ?? '', now); return du !== null && du >= 0; }).length;


export const timesheetValue = (e: Entry): string => { const c = valueCents(e.hours ?? '', e.rate ?? ''); return c === null ? '' : fmtR(twoDp(c)); };

export const isBilled = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'yes';

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


export function cellText(kind: string, e: Entry, field: string | undefined): string {
	const v = field ? (e[field] ?? '') : '';
	if (kind === 'money') { const p = parseAmount(v, 'signed-money'); return p.kind === 'ok' ? fmtR(twoDp(p.units)) : v; }
	if (kind === 'value') return timesheetValue(e);
	if (kind === 'date-or-dash') return v || '—';
	if (kind === 'category') return v || 'Other';
	return v;
}

import { monetaryCell } from '../../components/csv.ts';
export const registerCsv = (def: Shape, rows: readonly Row[]): string =>
	toCSV([def.fields.map((x) => x.k), ...rows.map((r) => def.fields.map((x) => (x.amount === 'signed-money' ? monetaryCell : userCell)(r.values[x.k] ?? '')))]);

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
export const icsDate = (date: string) => `${date.replace(/-/g, '')}T090000`;
export const icsProductId = (casePart: string | null) => (casePart ? `-//${icsText(casePart)}//Workspace//EN` : '-//ClearCase//Deadlines//EN');

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
