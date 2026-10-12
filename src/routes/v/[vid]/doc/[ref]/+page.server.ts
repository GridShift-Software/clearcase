import { error, fail } from '@sveltejs/kit';
import { app, originals } from '$lib/local-case/app.server';
import { documentRow } from '$lib/local-case/documents.server';
import type { AttachmentRow, OriginalLinks } from '$lib/local-case/model';
import { OriginalsServer } from '$lib/local-case/originals.server';
import { inTurn } from '$lib/local-case/registers.server';
import { UserWorkError } from '$lib/local-case/user-work.server';
import type { Actions, PageServerLoad } from './$types';

// note writes run in the case's register queue, so a restore of the case holds them back
const NOTES = 'note\u0000';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { version } = await parent();
	const a = app();
	const o = originals();
	// through the document-row contract: an imported ref is always the imported document; provider rows have pages too
	const r = documentRow(a.store, version.id, params.ref);
	if (!r) error(404, `No document ${params.ref.slice(0, 40)} in this results version`);
	const d = r.source === 'results' ? a.store.document(version.id, r.ref)! : null;
	const row = r.row;
	const state = r.state;
	const pageNo = Number(url.searchParams.get('page'));
	// Links only to an original that is on disk now: the same cheap check the originals site makes before hashing
	// (folder, existence, links, size). An original removed after import shows its missing state, not dead links.
	const NONE: OriginalLinks = { presentation: null, open: null, download: null, viewer: null };
	const linksFor = async (key: string): Promise<{ links: OriginalLinks; onDisk: string | null }> => {
		const asset = a.store.assetForServe(version.id, key);
		if (!asset?.real_path || asset.size === null || (asset.status !== 'verified' && asset.status !== 'case-mismatch')) return { links: NONE, onDisk: null };
		const gone = await OriginalsServer.availability({ ...asset, real_path: asset.real_path, size: asset.size });
		if (gone) return { links: NONE, onDisk: gone.reason };
		const name = asset.real_path.slice(asset.real_path.lastIndexOf('/') + 1);
		return { links: { presentation: OriginalsServer.presentation(asset), open: o.originalHref(version.id, key, name), download: o.downloadHref(version.id, key, name), viewer: o.viewerHref(version.id, key) }, onDisk: null };
	};
	const attachments = d ? await Promise.all((JSON.parse(d.attachments_json) as AttachmentRow[]).map(async (x) => ({ ...x, hasDocument: !!a.store.document(version.id, x.key), links: x.route === 'direct' ? (await linksFor(x.key)).links : null }))) : [];
	const own = d ? await linksFor(d.ref) : { links: NONE, onDisk: null };
	const refs = Array.isArray(row.refs) ? row.refs.map(str) : [];
	const parentRef = state.self?.parentRef ?? (typeof row.pr === 'string' ? row.pr : null);
	const existing = a.store.existingRefs(version.id, [...refs, ...(parentRef ? [parentRef] : [])]);
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

export const actions: Actions = {
	note: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const body = String((await request.formData()).get('body') ?? '');
		try { await inTurn(a.userWork, v.case_id, NOTES, () => a.userWork.addNote(v.case_id, v.id, params.ref, body)); } catch (e) { if (e instanceof UserWorkError) return fail(400, { message: e.message }); throw e; }
		return { saved: true };
	},
	delnote: async ({ request, params }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const id = String((await request.formData()).get('id') ?? '');
		await inTurn(a.userWork, v.case_id, NOTES, () => a.userWork.deleteNote(v.case_id, id));
		return { deleted: true };
	},
};
