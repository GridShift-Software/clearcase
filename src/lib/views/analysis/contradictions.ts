// Contradiction Tracker (GRS-15): v5 computes nothing here; every flag, count and category comes from the imported
// contradictions dataset in data order (S-contradictions_tab-1 is copied: the KPIs are the package's own figures).
// Browser-safe.
import { toCSV } from '../../components/csv.ts';
import { money } from '../../components/format.ts';

export interface ContradictionRef { ref: string; amount: string | number; filename: string }
export interface ContradictionItem { label: string; detail: string; rates?: Record<string, string>; spread?: string; refs: readonly ContradictionRef[] }
export interface ContradictionCategory { key: string; title: string; severity: string; explain: string; items: readonly ContradictionItem[] }
export interface Contradictions { total: number; highCount: number; byCat: Record<string, number>; checks: readonly { check: string; result: string }[]; categories: readonly ContradictionCategory[] }

const rate = (r: Record<string, string> | undefined, k: string) => (r && Object.hasOwn(r, k) ? r[k] : undefined);

/** One rate-basis row's money cells, as v5 shows them ('NEW RATE' stands in when 'NEW/STANDARD' is empty). */
export const rateCells = (it: ContradictionItem) => ({
	bid: money(rate(it.rates, 'BID RATE')),
	old: money(rate(it.rates, 'OLD RATE')),
	next: money(rate(it.rates, 'NEW/STANDARD') || rate(it.rates, 'NEW RATE')),
	spread: money(it.spread),
});

/** A non-rate item's spread: an amount reads 'Δ R 5.00' as in v5; any other text (a spelled-out range) as written. */
export const spreadLabel = (s: string) => (/^-?\d+(?:\.\d+)?$/.test(s) ? `Δ ${money(s)}` : s);

/** A source chip's label: the ref, and the amount when v5 shows one (a truthy amount: '<ref> · R 1 234.00'). */
export const chipLabel = (r: ContradictionRef) => (r.amount ? `${r.ref} · ${money(String(r.amount))}` : r.ref);

/** KPI figure by category key, 0 when the package has none (v5 `byCat.rate || 0`). */
export const byCat = (c: Contradictions, key: string) => (Object.hasOwn(c.byCat, key) ? c.byCat[key] || 0 : 0);

/** v5's export: one row per item of every category; an item without refs exports an empty refs cell. */
export const contradictionsCsv = (c: Contradictions) =>
	toCSV([['category', 'severity', 'item', 'detail', 'spread', 'refs'], ...c.categories.flatMap((cat) => cat.items.map((it) => [cat.title, cat.severity, it.label, it.detail || '', it.spread || '', (it.refs ?? []).map((x) => x.ref).join(' ')]))]);
/** The neutral export name; the package's name (view-content `exportFileName`) is used when it has one. */
export const CONTRADICTIONS_CSV_NAME = 'contradictions.csv';
