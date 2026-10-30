import type { RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor } from '$lib/submissions';

// POST seals the set in bounded steps: 202 asks the client to call again, 201 sealed it, 200 it was already sealed.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await intakeControllerFor(e)).sealSet(at(e));
