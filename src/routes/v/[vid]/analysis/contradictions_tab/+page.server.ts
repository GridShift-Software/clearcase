import { analysisDataset, existingOf } from '$lib/analysis/data.server';
import { app } from '$lib/local-case/app.server';
import { documentCounts } from '$lib/local-case/documents.server';
import { exportFileName, viewContentOf, viewText } from '$lib/local-case/results.server';
import { consistencyChecks, CONTRADICTIONS_CSV_NAME, type Contradictions } from '$lib/views/analysis/contradictions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const c = analysisDataset<Contradictions>(version.id, 'contradictions');
	const data = c ? {
		total: c.total, highCount: c.highCount, byCat: Object.entries(c.byCat),
		checks: consistencyChecks(c),
		categories: c.categories.map((cat) => ({ key: cat.key, title: cat.title, severity: cat.severity, explain: cat.explain,
			items: cat.items.map((it) => ({ label: it.label, detail: it.detail, spread: it.spread, rates: it.rates ? Object.entries(it.rates) : undefined, refs: it.refs.map((r) => ({ ref: r.ref, amount: r.amount, filename: r.filename })) })) })),
	} : null;
	const vc = viewContentOf(a.store, version.id);
	const methodNote = c ? viewText(vc, 'contradictions_tab', 'methodNote', { docCount: documentCounts(a.store, version.id).total.toLocaleString('en') }) : null;
	return { c: data, methodNote, exportName: exportFileName(vc, 'contradictions_tab', CONTRADICTIONS_CSV_NAME), known: c ? existingOf(version.id, c.categories.flatMap((cat) => cat.items.flatMap((it) => it.refs.map((r) => r.ref)))) : [] };
};
