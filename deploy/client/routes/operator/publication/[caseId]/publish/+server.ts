import type { RequestEvent } from '@sveltejs/kit';
import { publicationControllerFor } from '$lib/publication/hosted';

// Publishes one audited, still-current sign-off through a compare-and-set on the case's publication pointer.
// POST only: a human's session-bound action. The controller checks origin, session, revocation and explicit publish
// authority before it reads the body or any state; without composed ports it answers 503.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await publicationControllerFor(e)).publish(at(e));
