import type { RequestEvent } from '@sveltejs/kit';
import { serveAsset } from '$lib/viewer/hosted/route';

// One original, through the assets handle: authorized against the URL's case (read-original, so a grant for one case
// reaches no other), integrity-checked whole and audited before any byte is sent. GET, HEAD, single ranges with
// If-Range and ?download=1 are served; the presentation (inline for the in-app viewer, attachment otherwise) is
// decided in $lib/viewer/hosted/delivery. A refusal answers with its status and no body bytes.
export const GET = (event: RequestEvent) => serveAsset(event, 'original', 'GET');
export const HEAD = (event: RequestEvent) => serveAsset(event, 'original', 'HEAD');
