import { analysisDataset, existingOf } from '$lib/analysis/data.server';
import { app } from '$lib/local-case/app.server';
import { documentCounts } from '$lib/local-case/documents.server';
import { exportFileName, viewContentOf, viewText } from '$lib/local-case/results.server';
import { CONTRADICTIONS_CSV_NAME, type Contradictions } from '$lib/views/analysis/contradictions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const c = analysisDataset<Contradictions>(version.id, 'contradictions');
	// Plain copies for the page: values from the package never become object keys except the rate names and category
	// keys v5 reads, which travel as entries.
	const data = c ? {
		total: c.total, highCount: c.highCount, byCat: Object.entries(c.byCat),
		checks: c.checks.map((x) => ({ check: x.check, result: x.result })),
		categories: c.categories.map((cat) => ({ key: cat.key, title: cat.title, severity: cat.severity, explain: cat.explain,
			items: cat.items.map((it) => ({ label: it.label, detail: it.detail, spread: it.spread, rates: it.rates ? Object.entries(it.rates) : undefined, refs: it.refs.map((r) => ({ ref: r.ref, amount: r.amount, filename: r.filename })) })) })),
	} : null;
	// The method note is case wording from view-content, its document count derived from the register (S-meta-counts).
	// v5 names the export after the parties in code (S-hardcoded-case): the package's name, else a neutral one and a note.
	const vc = viewContentOf(a.store, version.id);
	const methodNote = c ? viewText(vc, 'contradictions_tab', 'methodNote', { docCount: documentCounts(a.store, version.id).total.toLocaleString('en') }) : null;
	return { c: data, methodNote, exportName: exportFileName(vc, 'contradictions_tab', CONTRADICTIONS_CSV_NAME), known: c ? existingOf(version.id, c.categories.flatMap((cat) => cat.items.flatMap((it) => it.refs.map((r) => r.ref)))) : [] };
};
