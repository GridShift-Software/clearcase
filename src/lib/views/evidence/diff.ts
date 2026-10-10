// Document Diff (v5 hoa_diff_tab, L2759-2774, diff helpers L218-228). Browser-safe and pure.
//  * The pair is explicitly chosen by the user (BA-06); nothing pairs documents automatically, and the page states that
//    the two are compared because they were chosen, not because they are known versions of each other.
//  * Every document with an indexed excerpt can be chosen (S-hoa_diff_tab-1, corrected: v5 offered the first 1,200).
//  * Only the indexed excerpts are compared (S-hoa_diff_tab-2): the page discloses each side's excerpt length and text
//    status (BA-06, BA-08); full-text comparison waits for a full-text rebuild.
//  * The diff is v5's: an LCS over whitespace-kept word tokens, or over lines, deletions before insertions. Its table
//    has one cell per pair of tokens and runs on the server, so a pair above MAX_CELLS is refused with a message (D10).
//  * The pair is resolved against the candidates, as the selects are: a ref that is not a document, or names one
//    without an excerpt, is said and not compared (D11).
import type { ChronologyListRow } from '../../local-case/model.ts';
import { cleanName } from './common.ts';

export type Op = 'eq' | 'del' | 'add';
export interface Segment { op: Op; text: string }

/** v5 lcsDiff: tokens of A and B; `sep` follows every emitted token (lines mode), outside a change. Adjacent same-op output merges. */
export function lcsDiff(A: readonly string[], B: readonly string[], sep = ''): Segment[] {
	const n = A.length, m = B.length;
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	const out: Segment[] = [];
	const merge = (op: Op, t: string) => { const last = out.at(-1); if (last && last.op === op) last.text += t; else if (t) out.push({ op, text: t }); };
	// v5 appends the separator after a changed token's span, as unchanged text
	const push = (op: Op, t: string) => { if (op === 'eq') merge('eq', t + sep); else { merge(op, t); merge('eq', sep); } };
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (A[i] === B[j]) { push('eq', A[i]!); i++; j++; }
		else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push('del', A[i++]!);
		else push('add', B[j++]!);
	}
	while (i < n) push('del', A[i++]!);
	while (j < m) push('add', B[j++]!);
	return out;
}
const words = (s: string) => s.split(/(\s+)/);
const lines = (s: string) => s.split(/\n/);
export const diffWords = (a: string, b: string) => lcsDiff(words(a), words(b));
export const diffLines = (a: string, b: string) => lcsDiff(lines(a), lines(b), '\n');
/**
 * The largest LCS table compared (token pairs): about 16 MB and some tens of milliseconds. Today's excerpts (at most
 * 500 characters, so at most about 500 tokens a side, 250,000 pairs) stay far below it.
 */
export const MAX_CELLS = 4_000_000;

export interface Candidate { ref: string; label: string }
/** Every document with an excerpt, in register order, labelled as v5 does ('ref · clean file name'). */
export const candidates = (rows: readonly ChronologyListRow[]): Candidate[] => rows.filter((r) => r.excerpt).map((r) => ({ ref: r.ref, label: `${r.ref} · ${cleanName(r.filename)}` }));

export interface Side { ref: string; name: string; chars: number; textStatus: string }
export type Comparison =
	| { kind: 'none' }
	| { kind: 'pick'; reasons: string[] }
	| { kind: 'too-long'; mode: 'words' | 'lines'; a: Side; b: Side; cells: number }
	| { kind: 'diff'; mode: 'words' | 'lines'; a: Side; b: Side; same: boolean; segments: Segment[] };

/** Compare the chosen pair (v5 runDiff): both refs must name a candidate (a document with an excerpt), else 'Pick two
 *  documents.', with the reason for a ref that is chosen but cannot be compared. */
export function compare(rows: readonly ChronologyListRow[], a: string | null, b: string | null, mode: string | null, submitted: boolean): Comparison {
	if (!submitted) return { kind: 'none' };
	const map = new Map<string, ChronologyListRow>();
	for (const r of rows) map.set(r.ref, r);
	const reasons: string[] = [];
	const pick = (ref: string | null, label: string) => {
		if (!ref) return undefined;
		const r = map.get(ref);
		if (!r) reasons.push(`Document ${label} “${ref.length > 40 ? `${ref.slice(0, 40)}…` : ref}” is not a document of this results version.`);
		else if (!r.excerpt) reasons.push(`Document ${label} ${ref} has no indexed excerpt, so it cannot be compared.`);
		else return r;
		return undefined;
	};
	const A = pick(a, 'A'), B = pick(b, 'B');
	if (!A || !B) return { kind: 'pick', reasons };
	const m = mode === 'lines' ? 'lines' : 'words';
	const side = (r: ChronologyListRow): Side => ({ ref: r.ref, name: cleanName(r.filename), chars: r.excerpt.length, textStatus: r.textStatus });
	const split = m === 'lines' ? lines : words;
	const ta = split(A.excerpt), tb = split(B.excerpt);
	if (ta.length * tb.length > MAX_CELLS) return { kind: 'too-long', mode: m, a: side(A), b: side(B), cells: ta.length * tb.length };
	return { kind: 'diff', mode: m, a: side(A), b: side(B), same: A.ref === B.ref, segments: m === 'lines' ? lcsDiff(ta, tb, '\n') : lcsDiff(ta, tb) };
}
