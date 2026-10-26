import type { RequestEvent } from '@sveltejs/kit';
import { nativeImportControllerFor } from '$lib/results-review/native';

// POST: a minimal authored correction of the current candidate. It creates a NEW validated candidate and link, supersedes
// the old one (so any sign-off of it no longer names a current candidate) and never edits a stored version.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await nativeImportControllerFor(e)).correct(at(e));
