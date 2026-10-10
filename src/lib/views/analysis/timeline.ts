// Timeline (GRS-15): the phased write-up, built as v5's renderer builds it (v5 lines 359-403). Browser-safe and pure;
// the server loads the datasets and the page renders the result as text.
import { fmtR } from '../../components/format.ts';
import type { ViewValue } from '../../case-package/view-content.ts';

export interface TimelineEvent { date: string; kind: string; ref: string; title: string; note: string }
export interface Phase { label: string; title: string; note: string; events: TimelineEvent[] }

/** v5 cleanName: drop a leading "(n) " and a .pdf/.eml/.msg extension. The result is shown once, as text. */
export const cleanName = (f: string) => String(f || '').replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');

/**
 * Events under each phase: a phase label is 'YYYY' or 'YYYY–YYYY' (only its first and last four characters are read)
 * and an event belongs to every phase whose years include its own, in data order. Events that fall in no phase (an
 * empty or unparsable date, or a year outside every phase) are returned apart, so none is silently dropped.
 */
export function phaseGroups(phases: readonly (readonly string[])[], events: readonly TimelineEvent[]): { phases: Phase[]; unplaced: TimelineEvent[] } {
	const ranges = phases.map((p) => ({ label: p[0] ?? '', title: p[1] ?? '', note: p[2] ?? '', lo: parseInt((p[0] ?? '').slice(0, 4)), hi: parseInt((p[0] ?? '').slice(-4)) }));
	const inPhase = (e: TimelineEvent, r: { lo: number; hi: number }) => { const y = parseInt(e.date.slice(0, 4)); return y >= r.lo && y <= r.hi; };
	return {
		phases: ranges.map((r) => ({ label: r.label, title: r.title, note: r.note, events: events.filter((e) => inPhase(e, r)) })),
		unplaced: events.filter((e) => !ranges.some((r) => inPhase(e, r))),
	};
}

/** Documents-by-year bars in the dataset's key order, each as tall as v5 draws it (the tallest is 100 px). */
export function yearBars(counts: readonly (readonly [string, number])[]) {
	const max = Math.max(0, ...counts.map(([, v]) => v));
	return counts.map(([year, n]) => ({ year, label: year.slice(2), count: n, height: max > 0 ? Math.round((n / max) * 100) : 0 }));
}

export interface SeriesPoint { date: string; amount: string | number }
/** v5 quantumChart: one bar per point on a 760×160 canvas, and the caption 'first → last · peak R …'. */
export function quantumBars(series: readonly SeriesPoint[]) {
	if (!series.length) return null;
	const W = 760, H = 160, pad = 8, n = series.length;
	const vals = series.map((s) => parseFloat(String(s.amount)) || 0);
	const max = Math.max(...vals);
	const bw = Math.max(2, (W - 2 * pad) / n - 2);
	// v5 scales by the largest value and writes a negative height for a negative amount (an invalid <rect>, which the
	// browser rejects with a console error and does not draw). A negative amount draws no bar here; its title still
	// names the imported amount, which is never changed.
	const top = Math.max(0, max);
	const bars = series.map((s, i) => {
		const h = top ? (Math.max(0, vals[i]!) / top) * (H - 2 * pad) : 0;
		return { x: (pad + i * ((W - 2 * pad) / n)).toFixed(1), y: (H - pad - h).toFixed(1), w: bw.toFixed(1), h: h.toFixed(1), title: `${s.date}: ${fmtR(String(s.amount))}` };
	});
	return { width: W, height: H, bars, caption: `${series[0]!.date} → ${series[n - 1]!.date} · peak ${fmtR(max)}` };
}

export type NotePart = { text: string } | { link: true };
/**
 * A view-content template as parts, every param filled from `params` except `linkParam`, which stays a link part for
 * the page to render as a citation (never as filled text). Null when the field is absent, not text or a template, or
 * names a param that cannot be filled: the view then leaves it out.
 */
export function templateParts(v: ViewValue | null, params: Readonly<Record<string, string>>, linkParam: string): NotePart[] | null {
	if (typeof v === 'string') return v.trim() ? [{ text: v }] : null;
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
	const out: NotePart[] = [];
	for (const p of v.template) {
		if (typeof p === 'string') out.push({ text: p });
		else if (p.param === linkParam) out.push({ link: true });
		else if (Object.hasOwn(params, p.param)) out.push({ text: params[p.param]! });
		else return null;
	}
	return out;
}
