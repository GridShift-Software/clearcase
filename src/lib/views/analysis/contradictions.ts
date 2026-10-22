import { toCSV } from '../../components/csv.ts';
import { money } from '../../components/format.ts';

export interface ContradictionRef { ref: string; amount: string | number; filename: string }
export interface ContradictionItem { label: string; detail: string; rates?: Record<string, string>; spread?: string; refs: readonly ContradictionRef[] }
export interface ContradictionCategory { key: string; title: string; severity: string; explain: string; items: readonly ContradictionItem[] }
export interface Contradictions { total: number; highCount: number; byCat: Record<string, number>; checks: readonly { check: string; result: string }[]; source_checks?: readonly { check: string; result: string }[]; categories: readonly ContradictionCategory[] }

export const consistencyChecks = (c: Contradictions) => [...c.checks, ...(c.source_checks ?? [])].map((x) => ({ check: x.check, result: x.result }));

const rate = (r: Record<string, string> | undefined, k: string) => (r && Object.hasOwn(r, k) ? r[k] : undefined);

export const rateCells = (it: ContradictionItem) => ({
	bid: money(rate(it.rates, 'BID RATE')),
	old: money(rate(it.rates, 'OLD RATE')),
	next: money(rate(it.rates, 'NEW/STANDARD') || rate(it.rates, 'NEW RATE')),
	spread: money(it.spread),
});

export const spreadLabel = (s: string) => (/^-?\d+(?:\.\d+)?$/.test(s) ? `Δ ${money(s)}` : s);

export const chipLabel = (r: ContradictionRef) => (r.amount ? `${r.ref} · ${money(String(r.amount))}` : r.ref);

export const byCat = (c: Contradictions, key: string) => (Object.hasOwn(c.byCat, key) ? c.byCat[key] || 0 : 0);

export const contradictionsCsv = (c: Contradictions) =>
	toCSV([['category', 'severity', 'item', 'detail', 'spread', 'refs'], ...c.categories.flatMap((cat) => cat.items.map((it) => [cat.title, cat.severity, it.label, it.detail || '', it.spread || '', (it.refs ?? []).map((x) => x.ref).join(' ')]))]);
export const CONTRADICTIONS_CSV_NAME = 'contradictions.csv';
