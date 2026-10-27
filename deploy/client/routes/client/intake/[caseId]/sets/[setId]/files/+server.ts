import type { RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor } from '$lib/submissions';

// POST declares one PDF of an open set, exactly as the single-file declaration, before its bytes are sent.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await intakeControllerFor(e)).declareSetFile(at(e));
