import type { RequestEvent } from '@sveltejs/kit';
import { nativeImportControllerFor } from '$lib/results-review/native';

// POST: one bounded JSON request carrying a processed results package and the finalized submission it was made from. The
// controller decides authority (verified staff, own client, the operate capability) before it reads any body byte, and
// answers 503 until the parent composes every required port. A candidate stays private; nothing here publishes.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await nativeImportControllerFor(e)).importPackage(at(e));
