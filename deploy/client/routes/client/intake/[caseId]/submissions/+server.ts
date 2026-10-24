import type { RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor } from '$lib/submissions';

// The case's submissions: GET lists every upload with its honest stage; POST declares one PDF before its bytes are sent.
// The controller decides authority before it reads any body, row or object; without composed ports it answers 503.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await intakeControllerFor(e)).list(at(e));
export const POST = async (e: RequestEvent) => (await intakeControllerFor(e)).declare(at(e));
