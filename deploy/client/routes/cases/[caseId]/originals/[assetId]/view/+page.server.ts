import type { RequestEvent } from '@sveltejs/kit';
import { codeOf, isDenial } from '$lib/server/runtime/errors';
import { refuse } from '$lib/server/runtime/hosted/http';
import { listPageNotes } from '$lib/viewer/hosted/page-notes';
import { assetRefOf } from '$lib/viewer/hosted/route';
import { originalView } from '$lib/viewer/hosted/view-model';

// The native viewer for one original. Authority is the case's read-original grant, decided before the page shows anything;
// a missing or changed original is shown as that (never as a blank viewer). Page notes load from user work and a fault
// there leaves the document readable.
export async function load({ locals, params, url }: RequestEvent) {
	const asset = assetRefOf('original', params as Record<string, string | undefined>);
	const view = await originalView({ assets: locals.assets, caseId: asset.caseId, assetId: asset.assetId }).catch((e) => refuse(e));
	const notes =
		view.state === 'available'
			? await listPageNotes({ work: locals.userWork, assets: locals.assets, caseId: asset.caseId, assetId: asset.assetId }).then(
					(items) => ({ state: 'available' as const, items }),
					(e: unknown) => (isDenial(e) ? refuse(e) : { state: 'unavailable' as const, items: [], code: codeOf(e) ?? 'error' }),
				)
			: { state: 'unavailable' as const, items: [], code: 'no-original' };
	return { caseId: asset.caseId, assetId: asset.assetId, view, notes, requestedPage: url.searchParams.get('page'), notesHref: `/cases/${encodeURIComponent(asset.caseId)}/originals/${encodeURIComponent(asset.assetId)}/notes` };
}
