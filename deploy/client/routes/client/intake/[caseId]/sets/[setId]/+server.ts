import type { RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor } from '$lib/submissions';

// GET reads one set and a page of its files (`?after=` the last page's cursor), so a client can show progress and resume.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await intakeControllerFor(e)).readSet(at(e));
