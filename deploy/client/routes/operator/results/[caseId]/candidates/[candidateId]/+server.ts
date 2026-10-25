import type { RequestEvent } from '@sveltejs/kit';
import { nativeImportControllerFor } from '$lib/results-review/native';

// GET: one private candidate and its immutable link, audited, to an operator holding the case's operate capability only.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await nativeImportControllerFor(e)).read(at(e));
