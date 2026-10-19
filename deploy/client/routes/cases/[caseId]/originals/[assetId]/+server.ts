import { error, type RequestEvent } from '@sveltejs/kit';
import { refuse } from '$lib/server/runtime/hosted/http';
import { id } from '$lib/server/runtime/ids';

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// One original, through the assets handle: authorized against the URL's case, integrity-checked whole and audited
// before any byte is sent. A refusal answers with its status and no body bytes.
async function serve({ locals, params, request }: RequestEvent, method: 'GET' | 'HEAD') {
	const { caseId, assetId } = params as Record<string, string | undefined>;
	if (!caseId || !assetId || !PART.test(caseId) || !PART.test(assetId)) error(404, { message: 'Not found.', code: 'not-found' });
	const asset = { kind: 'original' as const, caseId: id('case', caseId), assetId };
	return locals.assets.get({ asset, request: { method, range: request.headers.get('range'), ifRange: request.headers.get('if-range') } }).catch((e) => refuse(e));
}
export const GET = (event: RequestEvent) => serve(event, 'GET');
export const HEAD = (event: RequestEvent) => serve(event, 'HEAD');
