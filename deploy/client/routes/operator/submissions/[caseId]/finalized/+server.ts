import type { RequestEvent } from '@sveltejs/kit';
import { operatorDownloadControllerFor } from '$lib/submissions/download';

// The case's finalized submissions, newest sequence last. The controller decides authority before it reads any row or object;
// without composed ports it answers 503.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await operatorDownloadControllerFor(e)).list(at(e));
