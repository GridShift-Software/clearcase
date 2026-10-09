// Advanced Search (v5 search, L473-522). Browser-safe and pure; the server runs it over the document-row contract.
//  * The submitted search lives in the URL (v5 kept it in memory): it survives Back, reload and pagination, and the
//    export and the action items use exactly the submitted search (v5: the last collected state, S-search-1).
//  * Predicates are v5's (L497-507), ANDed: bundle, type, text status equal; sender a substring of sender+to+cc (glued
//    as v5 does, S-search-3, copied); from/to compared as text with undated rows excluded; amounts by parseFloat with
//    empty amounts excluded; the text a substring of filename, ref, subject, sender, to and excerpt (not cc).
//  * BA-15 (S-search-5): a reversed date or amount interval, or an amount bound that is not a number, is rejected
//    with a message and no result, distinct from a valid search that matches nothing.
//  * Results keep register order (v5), and the page says so; the export has the same order (BA-17).
//  * BA-08: what search covers is counted from the rows, never from summary metadata.
import type { ChronologyListRow } from '../../local-case/model.ts';
import type { Cell } from '../../components/csv.ts';
import { cleanName, paginate, type Page } from './common.ts';
import { money } from '../../components/format.ts';

export const PAGE_SIZE = 50;
export const FIELDS = ['q', 'bundle', 'type', 'sender', 'from', 'to', 'amin', 'amax', 'status'] as const;
export type SearchField = (typeof FIELDS)[number];
export type SearchQuery = Record<SearchField, string>;
export const EMPTY: SearchQuery = Object.freeze({ q: '', bundle: '', type: '', sender: '', from: '', to: '', amin: '', amax: '', status: '' });

/** A search row: the list projection plus the raw `cc` the sender predicate reads. */
export type SearchRow = ChronologyListRow & { cc: string };

/** The submitted search from URL parameters; `submitted` is false before the first Search (nothing is shown then). */
export function queryFromParams(p: URLSearchParams): { query: SearchQuery; submitted: boolean } {
	const query = Object.fromEntries(FIELDS.map((k) => [k, p.get(k) ?? ''])) as SearchQuery;
	return { query, submitted: FIELDS.some((k) => p.has(k)) };
}

const NUM = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
/** Why a search cannot run, or null. Each message names the fields; a valid search that matches nothing is not one. */
export function invalidReason(q: SearchQuery): string | null {
	const bad: string[] = [];
	if (q.amin && !NUM.test(q.amin)) bad.push('Amount min is not a number.');
	if (q.amax && !NUM.test(q.amax)) bad.push('Amount max is not a number.');
	if (q.from && q.to && q.from > q.to) bad.push('From date is after To date: the date interval is reversed.');
	if (!bad.length && q.amin && q.amax && parseFloat(q.amin) > parseFloat(q.amax)) bad.push('Amount min is greater than Amount max: the amount interval is reversed.');
	return bad.length ? bad.join(' ') : null;
}

/** v5 searchFiltered (L497-507), in register order. Run only on a valid query. */
export function searchRows(rows: readonly SearchRow[], S: SearchQuery): SearchRow[] {
	let a = rows.slice();
	if (S.bundle) a = a.filter((r) => r.bundle === S.bundle);
	if (S.type) a = a.filter((r) => r.docType === S.type);
	if (S.status) a = a.filter((r) => r.textStatus === S.status);
	if (S.sender) { const s = S.sender.toLowerCase(); a = a.filter((r) => `${r.sender}${r.to}${r.cc}`.toLowerCase().includes(s)); }
	if (S.from) a = a.filter((r) => r.date && r.date >= S.from);
	if (S.to) a = a.filter((r) => r.date && r.date <= S.to);
	if (S.amin) a = a.filter((r) => parseFloat(r.amount) >= parseFloat(S.amin));
	if (S.amax) a = a.filter((r) => parseFloat(r.amount) <= parseFloat(S.amax));
	if (S.q) { const q = S.q.toLowerCase(); a = a.filter((r) => `${r.filename} ${r.ref} ${r.subject} ${r.sender} ${r.to} ${r.excerpt}`.toLowerCase().includes(q)); }
	return a;
}

export interface ResultLine { ref: string; date: string; title: string; excerpt: string; type: string; bundle: string; amount: string; file: string }
const line = (r: SearchRow): ResultLine => ({ ref: r.ref, date: r.date, title: r.subject || cleanName(r.filename), excerpt: r.excerpt ? `${r.excerpt.slice(0, 120)}…` : '', type: r.docType, bundle: r.bundle, amount: money(r.amount), file: r.file });

export type SearchResult =
	| { kind: 'idle' }
	| { kind: 'invalid'; reason: string }
	| { kind: 'results'; page: Page<ResultLine> };

export function runSearch(rows: readonly SearchRow[], query: SearchQuery, submitted: boolean, page: number): SearchResult {
	if (!submitted) return { kind: 'idle' };
	const reason = invalidReason(query);
	if (reason) return { kind: 'invalid', reason };
	const p = paginate(searchRows(rows, query), page, PAGE_SIZE);
	return { kind: 'results', page: { ...p, slice: p.slice.map(line) } };
}

/** v5 ess_dcs_search.csv columns (L515-516), in result order, imported values unchanged. */
export const EXPORT_COLUMNS = ['ref', 'date', 'filename', 'subject', 'sender', 'doc_type', 'bundle', 'amount', 'text_status', 'url'] as const;
export const exportRows = (rows: readonly SearchRow[]): Cell[][] => [[...EXPORT_COLUMNS], ...rows.map((r) => [r.ref, r.date, r.filename, r.subject, r.sender, r.docType, r.bundle, r.amount, r.textStatus, r.url])];

/** v5 extractActionItems (L229-230): phrase matches longer than 8 characters, at most 20 per text. */
export function extractActionItems(text: string): string[] {
	if (!text) return [];
	const items: string[] = [];
	const re = /[^.!?\n]*\b(please|kindly|must|shall|require[sd]?|request(?:ed|ing)?|by\s+\d|before\s+\d|urgent|action|deadline|due\s+|submit|provide|await|revert)\b[^.!?\n]*[.!?]?/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) { const s = m[0].trim(); if (s.length > 8 && items.length < 20) items.push(s); }
	return items;
}
/** v5 actionItems (L517-522): every phrase of every matching row; the table shows the first 300. */
export function actionItems(rows: readonly SearchRow[]): { total: number; shown: { ref: string; date: string; t: string }[] } {
	const items = rows.flatMap((r) => extractActionItems(`${r.subject}. ${r.excerpt}`).map((t) => ({ ref: r.ref, date: r.date, t })));
	return { total: items.length, shown: items.slice(0, 300) };
}

export interface Coverage { documents: number; withExcerpt: number; maxExcerpt: number; extracted: number; none: number; pending: number; other: number }
/** BA-08: what search and comparison read, counted from the rows. */
export function coverage(rows: readonly Pick<ChronologyListRow, 'excerpt' | 'textStatus'>[]): Coverage {
	const c: Coverage = { documents: rows.length, withExcerpt: 0, maxExcerpt: 0, extracted: 0, none: 0, pending: 0, other: 0 };
	for (const r of rows) {
		if (r.excerpt) { c.withExcerpt++; c.maxExcerpt = Math.max(c.maxExcerpt, r.excerpt.length); }
		if (r.textStatus === 'extracted' || r.textStatus === 'ocr') c.extracted++;
		else if (r.textStatus === 'none') c.none++;
		else if (r.textStatus === 'pending') c.pending++;
		else c.other++;
	}
	return c;
}

/** The submitted search as URL parameters (all fields, as the form submits them), plus a page. */
export function paramsOf(q: SearchQuery, extra: Record<string, string> = {}): URLSearchParams {
	const p = new URLSearchParams();
	for (const k of FIELDS) p.set(k, q[k]);
	for (const [k, v] of Object.entries(extra)) p.set(k, v);
	return p;
}
