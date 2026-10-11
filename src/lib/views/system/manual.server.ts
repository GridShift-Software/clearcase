// Manual (GRS-20): the page's figures, the list of documents without extracted text (v5 "List scanned documents
// needing OCR") and a real check of the package's link sample (v5 only listed it, S-manual-1). Both lists are
// query-string states (?list=ocr, ?list=links), so they work without JavaScript and survive Back.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { documentRows } from '$lib/local-case/documents.server';
import { docPath, type OverviewModel } from '$lib/local-case/model';
import { ensureRescanProvider } from '$lib/local-case/rescan/rescan.server';
import { datasetOf } from '$lib/local-case/results.server';

type LinkRow = { ref: string; bundle: string; filename: string; url: string };

/** Whether a './'-relative package URL names a file inside the case folder (never outside it). */
async function onDisk(root: string, url: string): Promise<'found' | 'missing' | 'outside'> {
	let rel: string;
	try { rel = url.replace(/^\.\//, '').split('/').map(decodeURIComponent).join('/'); } catch { return 'outside'; }
	const file = path.resolve(root, rel);
	if (!url.startsWith('./') || !file.startsWith(path.resolve(root) + path.sep)) return 'outside';
	try { return (await stat(file)).isFile() ? 'found' : 'missing'; } catch { return 'missing'; }
}

export const load = async ({ params, url }: { params: Record<string, string>; url: URL }) => {
	const a = app();
	const v = a.store.getVersion(params.vid);
	if (!v) error(404, 'Unknown results version');
	ensureRescanProvider(a, v.case_id);
	const o = JSON.parse(v.overview) as OverviewModel;
	const docs = documentRows(a.store, v.id);
	const status = (s: string) => o.counts.byTextStatus[s] ?? 0;
	const noText = docs.rows.filter((r) => r.list.textStatus === 'none').map((r) => ({ ref: r.ref, bundle: r.list.bundle, filename: r.list.filename, href: docPath(v.id, r.ref) }));
	const sample = datasetOf<LinkRow[]>(a.store, v.id, 'link-sample');
	const list = url.searchParams.get('list');
	const links = list === 'links' && Array.isArray(sample)
		? await Promise.all(sample.map(async (r) => ({ ref: r.ref, bundle: r.bundle, filename: r.filename, href: docPath(v.id, r.ref), result: await onDisk(v.case_root, r.url) })))
		: null;
	return {
		badges: {
			documents: docs.rows.length,
			viaRescan: docs.rows.filter((r) => r.source === 'provider:rescanned').length,
			emails: o.counts.emails,
			people: o.counts.people,
			textNone: status('none'),
			textPending: status('pending'),
		},
		quantum: o.quantum ? { ref: o.quantum.headlineRef, date: o.quantum.headlineDate } : null,
		ocrCount: noText.length,
		ocr: list === 'ocr' ? noText : null,
		sampleCount: Array.isArray(sample) ? sample.length : null,
		links,
		list: list === 'ocr' || list === 'links' ? list : null,
	};
};
