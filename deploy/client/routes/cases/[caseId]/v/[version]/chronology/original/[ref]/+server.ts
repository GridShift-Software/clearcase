import { json, type RequestEvent } from '@sveltejs/kit';
import { refuse } from '$lib/server/runtime/hosted/http';
import { assetRefOf } from '$lib/viewer/hosted/route';
import { originalView } from '$lib/viewer/hosted/view-model';

// What the chronology's split pane shows for one document's original: the viewer page's own model (08's originalView,
// authorized by the case's read-original grant), read as JSON so the pane renders the same viewer beside the list. The
// app's pages refuse to be framed, so the pane cannot embed the viewer page itself. The answer holds a short-lived
// asset ticket for this reader: never cached.
export async function GET({ locals, params }: RequestEvent) {
	const p = params as Record<string, string | undefined>;
	const asset = assetRefOf('original', { caseId: p.caseId, assetId: p.ref });
	const view = await originalView({ assets: locals.assets, caseId: asset.caseId, assetId: asset.assetId }).catch((e: unknown) => refuse(e));
	const at = `/cases/${encodeURIComponent(asset.caseId)}/originals/${encodeURIComponent(asset.assetId)}`;
	return json({ view, viewHref: `${at}/view`, notesHref: `${at}/notes` }, { headers: { 'cache-control': 'private, no-store' } });
}
