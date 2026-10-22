import { fmtR } from '../../components/format.ts';
import type { ViewValue } from '../../case-package/view-content.ts';
import type { Static } from 'typebox';
import type { DatePhase as DatePhaseSchema } from '../../case-package/records';
import { revealInvisible } from '../../case-package/render';

export interface TimelineEvent { date: string; kind: string; ref: string; title: string; note: string; phase?: string; refs?: string[] }
export interface Phase { label: string; title: string; note: string; events: TimelineEvent[] }
export type DatePhase = Static<typeof DatePhaseSchema>;
export const eventReferences = (event: TimelineEvent): string[] => [...new Set([event.ref, ...(event.refs ?? [])].filter(Boolean))];

export function datePhaseGroups(phases: readonly DatePhase[], events: readonly TimelineEvent[]) {
	const keys = new Map<string, number>();
	for (const p of phases) keys.set(p.key, (keys.get(p.key) ?? 0) + 1);
	const known = (e: TimelineEvent) => e.phase !== undefined && keys.get(e.phase) === 1;
	return {
		phases: phases.map((p) => ({ label: `${p.from || 'Date not supplied'} → ${p.to || 'Date not supplied'}`, title: revealInvisible(p.title),
			note: revealInvisible([p.summary, p.oneLine && p.oneLine !== p.summary ? p.oneLine : '', keys.get(p.key)! > 1 ? 'Duplicate phase key: its events are listed outside the phases for review.' : '', p.from && p.to && p.from > p.to ? 'The supplied end date precedes the start date.' : ''].filter(Boolean).join('\n')),
			events: keys.get(p.key) === 1 ? events.filter((e) => e.phase === p.key) : [] })),
		unplaced: events.filter((e) => !known(e)),
	};
}

export const cleanName = (f: string) => String(f || '').replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');

export function phaseGroups(phases: readonly (readonly string[])[], events: readonly TimelineEvent[]): { phases: Phase[]; unplaced: TimelineEvent[] } {
	const ranges = phases.map((p) => ({ label: p[0] ?? '', title: p[1] ?? '', note: p[2] ?? '', lo: parseInt((p[0] ?? '').slice(0, 4)), hi: parseInt((p[0] ?? '').slice(-4)) }));
	const inPhase = (e: TimelineEvent, r: { lo: number; hi: number }) => { const y = parseInt(e.date.slice(0, 4)); return y >= r.lo && y <= r.hi; };
	return {
		phases: ranges.map((r) => ({ label: r.label, title: r.title, note: r.note, events: events.filter((e) => inPhase(e, r)) })),
		unplaced: events.filter((e) => !ranges.some((r) => inPhase(e, r))),
	};
}

export function yearBars(counts: readonly (readonly [string, number])[]) {
	const max = Math.max(0, ...counts.map(([, v]) => v));
	return counts.map(([year, n]) => ({ year, label: year.slice(2), count: n, height: max > 0 ? Math.round((n / max) * 100) : 0 }));
}

export interface SeriesPoint { date: string; amount: string | number }
export function quantumBars(series: readonly SeriesPoint[]) {
	if (!series.length) return null;
	const W = 760, H = 160, pad = 8, n = series.length;
	const vals = series.map((s) => parseFloat(String(s.amount)) || 0);
	const max = Math.max(...vals);
	const bw = Math.max(2, (W - 2 * pad) / n - 2);
	const top = Math.max(0, max);
	const bars = series.map((s, i) => {
		const h = top ? (Math.max(0, vals[i]!) / top) * (H - 2 * pad) : 0;
		return { x: (pad + i * ((W - 2 * pad) / n)).toFixed(1), y: (H - pad - h).toFixed(1), w: bw.toFixed(1), h: h.toFixed(1), title: `${s.date}: ${fmtR(String(s.amount))}` };
	});
	return { width: W, height: H, bars, caption: `${series[0]!.date} → ${series[n - 1]!.date} · peak ${fmtR(max)}` };
}

export type NotePart = { text: string } | { link: true };
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
