import { analysisAdditionsEnabled, analysisDataset, existingOf } from '$lib/analysis/data.server';
import { app } from '$lib/local-case/app.server';
import { documentCounts } from '$lib/local-case/documents.server';
import { money } from '$lib/components/format';
import { viewById } from '$lib/components/views';
import type { OverviewModel } from '$lib/local-case/model';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import { viewHeading } from '$lib/views/analysis/headings';
import { datePhaseGroups, phaseGroups, quantumBars, templateParts, yearBars, type DatePhase, type SeriesPoint, type TimelineEvent } from '$lib/views/analysis/timeline';
import type { PageServerLoad } from './$types';

interface Quantum { headline_due: string | number; headline_date: string; headline_ref: string; invoiceCount: number; amountDueSeries: SeriesPoint[] }
interface Person { name: string; email: string; org: string; total: number }
interface Meta { textNone: number }

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const rv = version.id;
	const events = (analysisDataset<TimelineEvent[]>(rv, 'timeline-events') ?? []).map((e) => ({ date: e.date, kind: e.kind, ref: e.ref, title: e.title, note: e.note, phase: e.phase, refs: e.refs }));
	const phases = analysisDataset<string[][] | DatePhase[]>(rv, 'timeline-phases') ?? [];
	const dated = phases.length > 0 && !Array.isArray(phases[0]);
	const grouped = dated ? datePhaseGroups(phases as DatePhase[], events) : phaseGroups(phases as string[][], events);
	const years = yearBars(Object.entries(analysisDataset<Record<string, number>>(rv, 'timeline-year-counts') ?? {}));
	const q = analysisDataset<Quantum>(rv, 'quantum');
	const people = (analysisDataset<Person[]>(rv, 'people') ?? []).slice(0, 8).map((p) => ({ name: p.name, email: p.email, org: p.org, total: p.total }));
	const meta = analysisDataset<Meta>(rv, 'meta');

	const v = a.store.getVersion(rv)!;
	const o = JSON.parse(v.overview) as OverviewModel;
	const bundle = (k: string) => (Object.hasOwn(o.counts.byBundle, k) ? String(o.counts.byBundle[k]) : '0');
	const vc = viewContentOf(a.store, rv);
	const docCount = documentCounts(a.store, rv).total.toLocaleString('en');
	const quantumParams: Record<string, string> = q ? { amountDue: money(String(q.headline_due)), asAt: q.headline_date, sourceRef: q.headline_ref, invoiceCount: String(q.invoiceCount) } : {};
	const content = {
		subtitle: viewText(vc, 'timeline', 'subtitle', { docCount }),
		synopsis: viewText(vc, 'timeline', 'synopsis', { docCount, original: bundle('Original'), supplementary: bundle('Supplementary'), correspondence: bundle('Correspondence'), dateFrom: o.dates.min ?? '', dateTo: o.dates.max ?? '' }),
		narrative: viewText(vc, 'timeline', 'narrative'),
		amountDueNote: q ? templateParts(vc.value('timeline', 'amountDueNote'), quantumParams, 'sourceLink') : null,
		emptyPhaseNote: viewText(vc, 'timeline', 'emptyPhaseNote'),
		quantumTrajectory: q ? viewText(vc, 'timeline', 'quantumTrajectory', quantumParams) : null,
		correspondentsIntro: viewText(vc, 'timeline', 'correspondentsIntro'),
		evidenceNotes: meta ? viewText(vc, 'timeline', 'evidenceNotes', { textNone: String(meta.textNone) }) : null,
	};
	return {
		heading: viewHeading(viewById('timeline')!, analysisAdditionsEnabled()),
		phases: grouped.phases,
		unplaced: grouped.unplaced,
		dated,
		years,
		chart: q ? quantumBars(q.amountDueSeries.map((s) => ({ date: s.date, amount: s.amount }))) : null,
		headlineRef: q?.headline_ref ?? null,
		people,
		content,
		known: existingOf(rv, [...events.flatMap((e) => [e.ref, ...(e.refs ?? [])]), ...(q?.headline_ref ? [q.headline_ref] : [])]),
	};
};
