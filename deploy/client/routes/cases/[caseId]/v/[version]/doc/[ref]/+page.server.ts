import type { Actions, RequestEvent } from '@sveltejs/kit';
import { serveModeOf } from '$lib/case-package/media';
import type { OriginalLinks } from '$lib/local-case/model';
import { codeOf, isDenial } from '$lib/server/runtime/errors';
import { refuse } from '$lib/server/runtime/hosted/http';
import { publishedVersion, shard } from '$lib/views/hosted/payloads.server';
import type { DocShard } from '$lib/views/payloads/doc';
import { guarded, hostedWork, noteView } from '$lib/views/hosted/work-adapter.server';
import { sha256 } from '$lib/server/runtime/ids';

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
			links = { presentation: presentationOf(doc.mediaType, doc.state.original?.downloadOnly ?? false, l.viewerHref), open: l.originalHref, download: l.downloadHref, viewer: l.viewerHref };
		} catch (e) {
			if (isDenial(e)) refuse(e);
			onDisk = codeOf(e) ?? 'not stored';
		}
	}
	const pageNo = Number(url.searchParams.get('page'));
	const { assetIds: _ids, mediaType: _media, originalState: _state, attachments, ...rest } = doc;
	return {
		...rest,
		links,
		onDisk,
		page: Number.isInteger(pageNo) && pageNo > 0 && pageNo < 1e6 ? pageNo : null,
		attachments: attachments.map((x) => ({ ...x, links: null })),
		base: v.base,
		notes: (await locals.userWork.notesFor({ caseId: v.caseId, target: { kind: 'document', anchor: {
			caseId: v.caseId, resultsVersion: v.resultsVersion, refAtCreation: doc.ref,
			sha256: doc.state.original ? sha256(doc.state.original.sha256) : null,
		} } }).catch(e => refuse(e))).map(noteView),
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
		return result.ok ? { saved: true } : result.failure;
	},
	delnote: async ({ locals, params, request }: RequestEvent) => {
		const v = await publishedVersion(locals, params);
		const form = await request.formData();
		const result = await guarded('delete', null, async (work) => work.deleteNote(v.caseId, String(form.get('id') ?? '')), SAY,
			{}, hostedWork(locals, v.caseId, v.resultsVersion, form));
		return result.ok ? { deleted: true } : result.failure;
	},
};
