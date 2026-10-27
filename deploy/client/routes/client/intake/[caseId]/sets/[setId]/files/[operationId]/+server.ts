import type { RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor } from '$lib/submissions';

// PUT sends one declared file's exact bytes (raw body, application/pdf). It stores the file; only the set's seal finalizes it.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const PUT = async (e: RequestEvent) => (await intakeControllerFor(e)).uploadSetFile(at(e));
