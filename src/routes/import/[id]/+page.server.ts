import { error, fail, redirect } from '@sveltejs/kit';
import type { Diagnostic } from '$lib/case-package/browser';
import { app } from '$lib/local-case/app.server';
import { diffVersions } from '$lib/local-case/diff.server';
import { versionPath } from '$lib/local-case/model';
import type { ImportReport } from '$lib/local-case/service.server';
import type { Actions, PageServerLoad } from './$types';

const LISTED_PER_CODE = 100;

export const load: PageServerLoad = ({ params, url }) => {
	const a = app();
	const imp = a.store.getImport(Number(params.id));
	if (!imp) error(404, 'No such import');
	const report = JSON.parse(imp.report) as ImportReport;
	const v = imp.results_version ? a.store.getVersion(imp.results_version) : undefined;
	const stored = imp.outcome === 'stored' && v?.import_id === imp.id;
	const caseId = report.caseId;
	const active = caseId ? a.effectiveActive(caseId) ?? null : null;
	// the trusted baseline is recomputed now: it may have changed since this import (another activation)
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
