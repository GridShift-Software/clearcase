import { fail, type Actions, type RequestEvent } from '@sveltejs/kit';
import { serveModeOf } from '$lib/case-package/media';
import type { OriginalLinks } from '$lib/local-case/model';
import { deleteStep } from '$lib/components/confirm-delete';
import { codeOf, isDenial } from '$lib/server/runtime/errors';
import { refuse } from '$lib/server/runtime/hosted/http';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { DocShard } from '$lib/views/payloads/doc';
import { guarded, hostedWork, noteView } from '$lib/views/hosted/work-adapter.server';
import { sha256 } from '$lib/server/runtime/ids';
import { documentPageNotes, PAGE_NOTE_STORE, pageNotes } from '$lib/views/hosted/page-note-items';
import { originalHref } from '$lib/views/hosted/paths';

const NONE: OriginalLinks = { presentation: null, open: null, download: null, viewer: null };

/** How the page offers an original of this media type; the hosted links carry no presentation. */
function presentationOf(mediaType: string | null, downloadOnly: boolean, viewer: string | null): NonNullable<OriginalLinks['presentation']> {
	if (downloadOnly || !mediaType) return 'download';
	const mode = serveModeOf(mediaType);
	if (mode === 'text-sandboxed') return 'text';
	if (mode === 'download') return 'download';
	if (mediaType === 'application/pdf') return viewer ? 'viewer' : 'download';
	return 'inline';
}

// The local document loader over its `doc/<ref>.json` shard: one links call for the document's own original (none per
// attachment). The admitted shard carries the document anchor, so reading notes needs no second document lookup.
export async function load({ locals, params, url }: RequestEvent) {
	const v = await publishedVersion(locals, params);
	// A ref the publication does not admit a shard for (unknown or malformed) is 404 before any storage read.
	const doc = await shard<DocShard>(locals, params, `doc/${params.ref ?? ''}.json`);
	let links = NONE, onDisk: string | null = null;
	if (doc.assetIds.own && doc.originalState === 'available') {
		try {
			const l = await locals.assets.links({ asset: { kind: 'original', caseId: v.caseId, assetId: doc.assetIds.own } });
			const presentation = presentationOf(doc.mediaType, doc.state.original?.downloadOnly ?? false, l.viewerHref);
			// An image opens in its viewer page: the raw original route answers with the bytes, which a browser may download.
			links = { presentation, open: presentation === 'inline' && l.viewerHref ? l.viewerHref : l.originalHref, download: l.downloadHref, viewer: l.viewerHref };
		} catch (e) {
			if (isDenial(e)) refuse(e);
			onDisk = codeOf(e) ?? 'not stored';
		}
	}
	// The document's notes, and the page notes written on its original's bytes in any version, are one read.
	const fingerprint = doc.state.original?.sha256 ?? null;
	const target = { kind: 'document' as const, anchor: { caseId: v.caseId, resultsVersion: v.resultsVersion, refAtCreation: doc.ref, sha256: fingerprint ? sha256(fingerprint) : null } };
	const work = await (fingerprint
		? locals.userWork.readNoteWork({ caseId: v.caseId, target, store: PAGE_NOTE_STORE, rowsWhere: { field: 'sha256', equals: fingerprint } })
		: locals.userWork.notesFor({ caseId: v.caseId, target }).then((notes) => ({ notes, rows: [] }))).catch((e) => refuse(e));
	const projected = pageNotes(v.caseId, work.rows);
	const pageNo = Number(url.searchParams.get('page'));
	const { assetIds: _ids, mediaType: _media, originalState: _state, attachments, ...rest } = doc;
	return {
		...rest,
		links,
		onDisk,
		page: Number.isInteger(pageNo) && pageNo > 0 && pageNo < 1e6 ? pageNo : null,
		attachments: attachments.map((x) => ({ ...x, links: x.route === 'direct' && doc.assetIds.attachments.includes(x.key)
			? { ...NONE, presentation: 'download' as const, download: `${originalHref(v.caseId, x.key)}?download=1` } : null })),
		base: v.base,
		notes: work.notes.map(noteView),
		/** read only here: each links to its original's viewer, where it is changed or deleted */
		pageNotes: documentPageNotes(projected, { sha256: fingerprint, assetId: doc.assetIds.own }),
		pageNotesUnreadable: projected.unreadable,
		operationId: crypto.randomUUID(),
	};
}

const SAY = {
	busy: 'The note was not saved: the store is busy or unavailable. Your text is kept; try again.',
	refused: 'The note was not saved. Check its text and try again.',
	failed: 'The note was not saved: something went wrong. Your text is kept; try again.',
};
export const actions: Actions = {
	note: async ({ locals, params, request }: RequestEvent) => {
		const v = await publishedVersion(locals, params);
		const form = await request.formData(), body = String(form.get('body') ?? '');
		const operationId = String(form.get('operationId') ?? '') || crypto.randomUUID();
		form.set('operationId', operationId);
		const result = await guarded('note', { body }, async (work) => work.addNote(v.caseId, v.resultsVersion, params.ref ?? '', body), SAY,
			{ body, operationId }, hostedWork(locals, v.caseId, v.resultsVersion, form));
		// The saved note and the next form's operation id: the page shows the note without waiting for its reload (GRS-261).
		return result.ok ? { saved: true, note: result.value, operationId: crypto.randomUUID() } : result.failure;
	},
	delnote: async ({ locals, params, request }: RequestEvent) => {
		const v = await publishedVersion(locals, params);
		const form = await request.formData(), id = String(form.get('id') ?? '');
		// a Delete not confirmed for this note reaches no work store: the page asks, or after Cancel does not (GRS-280)
		const step = deleteStep(form, id);
		if (step !== 'confirm') return fail(400, { op: 'delete' as const, confirm: step === 'ask' ? id : null });
		const result = await guarded('delete', null, async (work) => work.deleteNote(v.caseId, id), SAY,
			{}, hostedWork(locals, v.caseId, v.resultsVersion, form));
		return result.ok ? { deleted: true } : result.failure;
	},
};
