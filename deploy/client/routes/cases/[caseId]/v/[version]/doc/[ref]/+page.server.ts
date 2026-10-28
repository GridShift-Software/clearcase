import { error, type RequestEvent } from '@sveltejs/kit';
import { serveModeOf } from '$lib/case-package/media';
import type { OriginalLinks } from '$lib/local-case/model';
import { codeOf, isDenial } from '$lib/server/runtime/errors';
import { refuse } from '$lib/server/runtime/hosted/http';
import { publishedVersion } from '$lib/views/hosted/payloads.server';
import type { DocShard } from '$lib/views/payloads/doc';
import { validShardName } from '$lib/results/hosted/shards';

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
// attachment), and no notes yet (ticket 16 adds the notes read and the note actions).
export async function load({ locals, params, url }: RequestEvent) {
	const v = await publishedVersion(locals, params);
	const ref = params.ref ?? '';
	const name = `doc/${ref}.json`;
	const missing = () => error(404, { message: `No document ${ref.slice(0, 40)} in this results version`, code: 'not-found' });
	if (!validShardName(name)) missing();
	const response = await locals.shards.read({ caseId: v.caseId, resultsVersion: v.resultsVersion, name }).catch((e: unknown) => refuse(e));
	if (!response) missing();
	let doc: DocShard;
	try { doc = JSON.parse(await response!.text()) as DocShard; }
	catch { error(503, { message: 'The published results cannot be shown right now. Try again shortly.', code: 'invalid-package' }); }
	let links = NONE, onDisk: string | null = null;
	if (doc!.assetIds.own && doc!.originalState === 'available') {
		try {
			const l = await locals.assets.links({ asset: { kind: 'original', caseId: v.caseId, assetId: doc!.assetIds.own } });
			links = { presentation: presentationOf(doc!.mediaType, doc!.state.original?.downloadOnly ?? false, l.viewerHref), open: l.originalHref, download: l.downloadHref, viewer: l.viewerHref };
		} catch (e) {
			if (isDenial(e)) refuse(e);
			onDisk = codeOf(e) ?? 'not stored';
		}
	}
	const pageNo = Number(url.searchParams.get('page'));
	const { assetIds: _ids, mediaType: _media, originalState: _state, attachments, ...rest } = doc!;
	return {
		...rest,
		links,
		onDisk,
		page: Number.isInteger(pageNo) && pageNo > 0 && pageNo < 1e6 ? pageNo : null,
		attachments: attachments.map((x) => ({ ...x, links: null })),
		base: v.base,
		notes: [] as never[],
	};
}
