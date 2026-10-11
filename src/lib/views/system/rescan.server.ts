// Rescan & Update (GRS-20): the page's data and actions. The scan itself is $lib/local-case/rescan; this module only
// reads its state for one results version and runs it on a form post (works without JavaScript).
import { error, fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { docPath } from '$lib/local-case/model';
import { additions, clearAdditions, ensureRescanProvider, lastRun, rescan, rescanRows, rescanTables, ScanError } from '$lib/local-case/rescan/rescan.server';

type Event = { params: Record<string, string>; request: Request };

function versionOf(vid: string) {
	const a = app();
	const v = a.store.getVersion(vid);
	if (!v) error(404, 'Unknown results version');
	ensureRescanProvider(a);
	return { a, v };
}

export const load = async ({ params }: { params: Record<string, string> }) => {
	const { a, v } = versionOf(params.vid);
	await rescanTables(a);
	const rows = rescanRows(a, v.case_id, v.id);
	const row = (r: (typeof rows)[number]) => ({ path: r.path, filename: r.path.split('/').pop() ?? r.path, ref: r.ref, date: r.date, docType: r.docType, bundle: r.bundle, evidence: r.evidence, processing: r.processing, href: r.kind === 'added' ? docPath(v.id, r.ref) : null });
	return {
		caseFolder: v.case_folder,
		run: lastRun(a, v.case_id, v.id),
		added: rows.filter((r) => r.kind === 'added').map(row),
		withdrawn: rows.filter((r) => r.kind === 'withdrawn').map(row),
		changed: rows.filter((r) => r.kind === 'changed').map(row),
		removed: rows.filter((r) => r.kind === 'removed').map(row),
	};
};

export const actions = {
	scan: async ({ params, request }: Event) => {
		const { a, v } = versionOf(params.vid);
		const mode = (await request.formData()).get('mode') === 'full' ? 'full' : 'quick';
		try {
			const r = await rescan(a, v.id, mode);
			return { scanned: { mode, newlyAdded: r.counts.newlyAdded, skipped: r.skipped } };
		} catch (e) {
			if (e instanceof ScanError) return fail(409, { message: `The scan did not run: ${e.message}. Nothing was changed.` });
			throw e;
		}
	},
	clear: async ({ params, request }: Event) => {
		const { a, v } = versionOf(params.vid);
		if ((await request.formData()).get('confirm') !== 'yes') return fail(400, { message: 'Tick “Yes, clear the additions” to clear them. Nothing was changed.' });
		const n = await clearAdditions(a, v.id);
		return { cleared: n };
	},
};

/** The additions as v5's ess_dcs_rescan_v1.json ("Write updated index to file"): an array of v5 rescan rows. */
export function indexFile(vid: string): string {
	const { a, v } = versionOf(vid);
	return `${JSON.stringify(additions(a, v.case_id, v.id).map((p) => p.row), null, 2)}\n`;
}
