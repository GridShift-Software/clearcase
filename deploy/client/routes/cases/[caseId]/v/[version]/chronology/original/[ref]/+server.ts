import { error, json, type RequestEvent } from '@sveltejs/kit';
import { refuse } from '$lib/server/runtime/hosted/http';
import { assetRefOf } from '$lib/viewer/hosted/route';
import { originalView } from '$lib/viewer/hosted/view-model';
import { publishedVersion } from '$lib/views/hosted/payloads.server';
import { documentRow } from '../../list-pages.server';

// What the chronology's split pane shows for one document's original: the viewer page's own model (08's originalView,
// authorized by the case's read-original grant), read as JSON so the pane renders the same viewer beside the list. The
// app's pages refuse to be framed, so the pane cannot embed the viewer page itself. The ref must name a document of the
// case's published version (the URL's version, authorized by 06's publishedVersion) whose own original is present; its
// asset is the one keyed by that ref, never an attachment or a package file. Anything else is 404 before any asset is
// looked up or a ticket minted. The answer holds a short-lived asset ticket for this reader: never cached.
const notFound = (): never => error(404, { message: 'Not found.', code: 'not-found' });

export async function GET({ locals, params }: RequestEvent) {
	const p = params as Record<string, string | undefined>;
	const asset = assetRefOf('original', { caseId: p.caseId, assetId: p.ref });
	const v = await publishedVersion(locals, p);
	const row = await documentRow(locals, v, asset.assetId);
	if (!row || row.file !== 'present') notFound();
	const view = await originalView({ assets: locals.assets, caseId: v.caseId, assetId: row!.ref }).catch((e: unknown) => refuse(e));
	const at = `/cases/${encodeURIComponent(v.caseId)}/originals/${encodeURIComponent(row!.ref)}`;
	return json({ view, viewHref: `${at}/view`, notesHref: `${at}/notes` }, { headers: { 'cache-control': 'private, no-store' } });
}
