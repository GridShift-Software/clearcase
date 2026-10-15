import { error } from '@sveltejs/kit';
import { actionCase, guarded, type Say } from '$lib/local-case/answer.server';
import { app, originals } from '$lib/local-case/app.server';
import { documentRow, resolveRefs } from '$lib/local-case/documents.server';
import type { AttachmentRow, OriginalLinks } from '$lib/local-case/model';
import { OriginalsServer } from '$lib/local-case/originals.server';
import { inTurn } from '$lib/local-case/registers.server';
import type { Actions, PageServerLoad } from './$types';

const NOTES = 'note\u0000';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { version } = await parent();
	const a = app();
	const o = originals();
	const r = documentRow(a.store, version.id, params.ref);
	if (!r) error(404, `No document ${params.ref.slice(0, 40)} in this results version`);
	const d = r.source === 'results' ? a.store.document(version.id, r.ref)! : null;
	const row = r.row;
	const state = r.state;
	const pageNo = Number(url.searchParams.get('page'));
	const NONE: OriginalLinks = { presentation: null, open: null, download: null, viewer: null };
	const linksFor = async (key: string): Promise<{ links: OriginalLinks; onDisk: string | null }> => {
		const asset = a.store.assetForServe(version.id, key);
		if (!asset?.real_path || asset.size === null || (asset.status !== 'verified' && asset.status !== 'case-mismatch')) return { links: NONE, onDisk: null };
		const gone = await OriginalsServer.availability({ ...asset, real_path: asset.real_path, size: asset.size });
		if (gone) return { links: NONE, onDisk: gone.reason };
		const name = asset.real_path.slice(asset.real_path.lastIndexOf('/') + 1);
		return { links: { presentation: OriginalsServer.presentation(asset), open: o.originalHref(version.id, key, name), download: o.downloadHref(version.id, key, name), viewer: o.viewerHref(version.id, key) }, onDisk: null };
	};
	const atts = d ? (JSON.parse(d.attachments_json) as AttachmentRow[]) : [];
	const attDocs = resolveRefs(a.store, version.id, atts.map((x) => x.key));
	const attachments = await Promise.all(atts.map(async (x) => ({ ...x, hasDocument: attDocs.has(x.key), links: x.route === 'direct' ? (await linksFor(x.key)).links : null })));
	const own = d ? await linksFor(d.ref) : { links: NONE, onDisk: null };
	const refs = Array.isArray(row.refs) ? row.refs.map(str) : [];
	const parentRef = state.self?.parentRef ?? (typeof row.pr === 'string' ? row.pr : null);
	const existing = resolveRefs(a.store, version.id, [...refs, ...(parentRef ? [parentRef] : [])]);
	return {
		ref: r.ref,
		source: r.source,
		fields: {
			date: str(row.date), dateType: typeof row.date_type === 'string' ? row.date_type : null, dateSource: typeof row.date_source === 'string' ? row.date_source : null,
			subject: str(row.subject), filename: str(row.filename), docType: str(row.doc_type), bundle: str(row.bundle), sender: str(row.sender), to: str(row.to), cc: str(row.cc),
			amount: str(row.amount), invoiceNo: str(row.invoice_no), size: typeof row.size === 'number' ? row.size : null, textStatus: str(row.text_status),
			alsoIn: Array.isArray(row.also_in) ? row.also_in.map(str) : [], attachmentNames: Array.isArray(row.attachments) ? row.attachments.map(str) : [], excerpt: str(row.excerpt),
		},
		state,
		links: own.links,
		onDisk: own.onDisk,
		page: Number.isInteger(pageNo) && pageNo > 0 && pageNo < 1e6 ? pageNo : null,
		attachments,
		children: d ? a.store.childDocuments(version.id, d.ref).map((c) => c.ref) : [],
		related: refs.map((r) => ({ ref: r, exists: existing.has(r) })),
		parent: parentRef ? { ref: parentRef, exists: existing.has(parentRef) } : null,
		notes: a.userWork.notesFor(version.caseId, version.id, r.ref),
	};
};

const SAY: Say = {
	busy: 'The note was not saved: the store is busy or unavailable. Your text is kept; try again.',
	refused: (e) => `The note was not saved: ${e.message}`,
	failed: 'The note was not saved: something went wrong. Your text is kept; try again.',
};

export const actions: Actions = {
	note: async ({ request, params }) => {
		const { caseId } = actionCase(params);
		const body = String((await request.formData()).get('body') ?? '');
		const w = await guarded('note', { body }, () => inTurn(app().userWork, caseId, NOTES, () => app().userWork.addNote(caseId, params.vid, params.ref, body)), SAY, { body });
		if (!w.ok) {
			if (w.failure.status === 503 && request.headers.get('accept')?.includes('application/json')) error(503, w.failure.data.message);
			return w.failure;
		}
		return { saved: true };
	},
	delnote: async ({ request, params }) => {
		const { caseId } = actionCase(params);
		const id = String((await request.formData()).get('id') ?? '');
		const w = await guarded('delete', null, () => inTurn(app().userWork, caseId, NOTES, () => app().userWork.deleteNote(caseId, id)), SAY);
		return w.ok ? { deleted: true } : w.failure;
	},
};
