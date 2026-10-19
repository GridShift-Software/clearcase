import { error, fail, redirect } from '@sveltejs/kit';
import { CODES, type Diagnostic } from '$lib/case-package/browser';
import { CONVERSION_REPORT } from '$lib/case-package/registry';
import { app } from '$lib/local-case/app.server';
import { diffVersions } from '$lib/local-case/diff.server';
import { versionPath } from '$lib/local-case/model';
import { datasetOf } from '$lib/local-case/results.server';
import type { ImportReport } from '$lib/local-case/service.server';
import type { Actions, PageServerLoad } from './$types';

const LISTED_PER_CODE = 100;

type ConversionNote = { code: string; subject: string | null; message: string };

const conversionNotes = (vid: string) => datasetOf<{ diagnostics: ConversionNote[] }>(app().store, vid, CONVERSION_REPORT.key)?.diagnostics ?? null;

/**
 * How much document text the source export cut short, from the converter's V5_TEXT_CAPPED diagnostics: null when it
 * reports none, and `known: false` when the package has no readable conversion report, so a missing report never reads
 * as complete text.
 */
function textCoverage(notes: ConversionNote[] | null): { known: boolean; notes: string[]; hint: string } | null {
	const hint = CODES.V5_TEXT_CAPPED.hint;
	if (!notes) return { known: false, notes: [], hint };
	const capped = notes.filter((d) => d.code === 'V5_TEXT_CAPPED').map((d) => d.message);
	return capped.length ? { known: true, notes: capped, hint } : null;
}

/**
 * Every other note the converter recorded about the source (data kept as an opaque dataset and not shown, an analysis
 * overlay it does not map, a dropped index, ...), grouped by code with its subject and the converter's own counts: null
 * when it recorded none, `known: false` when the package has no readable conversion report. No code list: a note the
 * converter gains later shows up here without a change to this route.
 */
function sourceCoverage(notes: ConversionNote[] | null) {
	if (!notes) return { known: false, groups: [] };
	const byCode = new Map<string, ConversionNote[]>();
	for (const d of notes) if (d.code !== 'V5_TEXT_CAPPED') byCode.set(d.code, [...(byCode.get(d.code) ?? []), d]);
	if (!byCode.size) return null;
	const groups = [...byCode].sort(([x], [y]) => (x < y ? -1 : 1)).map(([code, ds]) => ({
		code, hint: (CODES as Record<string, { hint: string }>)[code]?.hint ?? '', total: ds.length,
		items: ds.slice(0, LISTED_PER_CODE).map((d) => ({ subject: d.subject, message: d.message })),
	}));
	return { known: true, groups };
}

export const load: PageServerLoad = ({ params, url }) => {
	const a = app();
	const imp = a.store.getImport(Number(params.id));
	if (!imp) error(404, 'No such import');
	const report = JSON.parse(imp.report) as ImportReport;
	const v = imp.results_version ? a.store.getVersion(imp.results_version) : undefined;
	const stored = imp.outcome === 'stored' && v?.import_id === imp.id;
	const caseId = report.caseId;
	const active = caseId ? a.effectiveActive(caseId) ?? null : null;
	const trusted = caseId ? a.trustedFor(caseId) : new Set<string>();
	const newWarnings = report.warningFingerprints.filter((f) => !trusted.has(f));
	const fresh = new Set(newWarnings);
	const byCode = new Map<string, Diagnostic[]>();
	for (const d of report.diagnostics) byCode.set(d.code, [...(byCode.get(d.code) ?? []), d]);
	const sevOrder = { error: 0, warning: 1, info: 2 } as const;
	const groups = [...byCode].map(([code, ds]) => ({
		code, severity: ds[0]!.severity, cls: ds[0]!.cls, hint: ds[0]!.hint, total: report.counts[code] ?? ds.length,
		newCount: ds.filter((d) => d.severity === 'warning' && fresh.has(d.fingerprint)).length,
		items: ds.slice(0, LISTED_PER_CODE).map((d) => ({ subject: d.subject, file: d.file, pointer: d.pointer, message: d.message, fingerprint: d.fingerprint, isNew: d.severity === 'warning' && fresh.has(d.fingerprint) })),
	})).sort((x, y) => sevOrder[x.severity] - sevOrder[y.severity] || (x.code < y.code ? -1 : 1));
	const vid = stored ? v!.id : null;
	return {
		imp: { id: imp.id, at: imp.at, caseFolder: imp.case_folder, packageSource: imp.package_source, outcome: imp.outcome },
		report: { verdict: report.verdict, caseId, caseLabel: report.caseLabel, resultsVersion: report.resultsVersion, manifestSha256: report.manifestSha256, diagnosticsSha256: report.diagnosticsSha256, validatorVersion: report.validatorVersion, ms: report.ms, app: report.app, counts: report.counts, warnings: report.warningFingerprints.length, errors: report.errorFingerprints.length },
		groups, newWarnings, knownWarnings: report.warningFingerprints.length - newWarnings.length,
		vid, active,
		pruned: imp.outcome === 'stored' && !v, supersededBy: imp.outcome === 'stored' && v && v.import_id !== imp.id ? v.import_id : null,
		check: vid ? a.verify(vid) : null,
		textCoverage: vid ? textCoverage(conversionNotes(vid)) : null,
		sourceCoverage: vid ? sourceCoverage(conversionNotes(vid)) : null,
		diff: vid && active && active !== vid ? diffVersions(a.store, vid, active) : null,
		notes: vid && caseId ? a.userWork.summary(caseId, vid) : null,
		noop: url.searchParams.has('noop'), repaired: url.searchParams.has('repaired'),
	};
};

export const actions: Actions = {
	activate: async ({ request, params }) => {
		const a = app();
		const imp = a.store.getImport(Number(params.id));
		const v = imp?.results_version ? a.store.getVersion(imp.results_version) : undefined;
		if (!imp || imp.outcome !== 'stored' || !v) return fail(400, { reasons: [] as string[], message: 'This import has no stored candidate to activate (rejected, removed by retention, or imported again under a newer import).' });
		const f = await request.formData();
		const s = (k: string) => String(f.get(k) ?? '');
		const ack = f.get('ack') === 'on'
			? { resultsVersion: s('resultsVersion'), manifestSha256: s('manifestSha256'), diagnosticsSha256: s('diagnosticsSha256'), validatorVersion: s('validatorVersion'), warningFingerprints: f.getAll('fp').map(String) }
			: null;
		const refused = await a.activate(v.id, ack);
		if (refused) return fail(409, { message: refused.message, reasons: refused.reasons?.map((r) => r.code) ?? [] });
		redirect(303, `${versionPath(v.id)}/overview`);
	},
};
