import { error, fail } from '@sveltejs/kit';
import { app, originals } from '$lib/local-case/app.server';
import type { AttachmentRow, DocumentStateRow, OriginalLinks } from '$lib/local-case/model';
import { OriginalsServer } from '$lib/local-case/originals.server';
import { UserWorkError } from '$lib/local-case/user-work.server';
import type { Actions, PageServerLoad } from './$types';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { version } = await parent();
	const a = app();
	const o = originals();
	const d = a.store.document(version.id, params.ref);
	if (!d) error(404, `No document ${params.ref.slice(0, 40)} in this results version`);
	const row = JSON.parse(d.row_json) as Record<string, unknown>;
	const state = JSON.parse(d.state_json) as DocumentStateRow;
	const pageNo = Number(url.searchParams.get('page'));
	const linksFor = (key: string): OriginalLinks => {
		const asset = a.store.assetForServe(version.id, key);
		if (!asset?.real_path || (asset.status !== 'verified' && asset.status !== 'case-mismatch')) return { presentation: null, open: null, download: null, viewer: null };
		const name = asset.real_path.slice(asset.real_path.lastIndexOf('/') + 1);
		return { presentation: OriginalsServer.presentation(asset), open: o.originalHref(version.id, key, name), download: o.downloadHref(version.id, key, name), viewer: o.viewerHref(version.id, key) };
	};
	const attachments = (JSON.parse(d.attachments_json) as AttachmentRow[]).map((x) => ({ ...x, hasDocument: !!a.store.document(version.id, x.key), links: x.route === 'direct' ? linksFor(x.key) : null }));
	const refs = Array.isArray(row.refs) ? row.refs.map(str) : [];
	const parentRef = state.self?.parentRef ?? (typeof row.pr === 'string' ? row.pr : null);
	const existing = a.store.existingRefs(version.id, [...refs, ...(parentRef ? [parentRef] : [])]);
	return {
		ref: d.ref,
		fields: {
			date: str(row.date), dateType: typeof row.date_type === 'string' ? row.date_type : null, dateSource: typeof row.date_source === 'string' ? row.date_source : null,
			subject: str(row.subject), filename: str(row.filename), docType: str(row.doc_type), bundle: str(row.bundle), sender: str(row.sender), to: str(row.to), cc: str(row.cc),
			amount: str(row.amount), invoiceNo: str(row.invoice_no), size: typeof row.size === 'number' ? row.size : null, textStatus: str(row.text_status),
			alsoIn: Array.isArray(row.also_in) ? row.also_in.map(str) : [], attachmentNames: Array.isArray(row.attachments) ? row.attachments.map(str) : [], excerpt: str(row.excerpt),
		},
		state,
		links: linksFor(d.ref),
		page: Number.isInteger(pageNo) && pageNo > 0 && pageNo < 1e6 ? pageNo : null,
		attachments,
		children: a.store.childDocuments(version.id, d.ref).map((c) => c.ref),
		related: refs.map((r) => ({ ref: r, exists: existing.has(r) })),
		parent: parentRef ? { ref: parentRef, exists: existing.has(parentRef) } : null,
		notes: a.userWork.notesFor(version.caseId, version.id, d.ref),
	};
};

export const actions: Actions = {
	note: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const body = String((await request.formData()).get('body') ?? '');
		try { await a.userWork.addNote(v.case_id, v.id, params.ref, body); } catch (e) { if (e instanceof UserWorkError) return fail(400, { message: e.message }); throw e; }
		return { saved: true };
	},
	delnote: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		await a.userWork.deleteNote(v.case_id, String((await request.formData()).get('id') ?? ''));
		return { deleted: true };
	},
};
