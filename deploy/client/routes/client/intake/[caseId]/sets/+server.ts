import type { RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor } from '$lib/submissions';

// POST opens a set of PDFs (one multi-file submission) with its file count and total bytes. The controller decides authority
// and refuses a set over the cap before it reads any row or writes anything; without composed ports it answers 503.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await intakeControllerFor(e)).openSet(at(e));
