import type { RequestEvent } from '@sveltejs/kit';
import { recoveryControllerFor } from '$lib/recovery/hosted/composition';

// POST only: a signed-in person's bounded JSON command for the native /2 recovery archive. The controller checks
// origin, media type, the exact request's binding, session and case before it reads the body, and answers 503 until the
// trusted parent binds real dependencies. The case comes from this route, never from the body.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await recoveryControllerFor(e)).plan(at(e));
