import type { RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor } from '$lib/submissions';

// One upload: PUT sends the declared PDF's exact bytes (raw body, application/pdf) and finalizes the submission; GET
// reads its stage and, once finalized, its immutable manifest and the download handoff through the case originals route.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await intakeControllerFor(e)).read(at(e));
export const PUT = async (e: RequestEvent) => (await intakeControllerFor(e)).upload(at(e));
