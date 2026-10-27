import type { RequestEvent } from '@sveltejs/kit';
import { evidenceBuildControllerFor } from '$lib/publication/hosted/evidence-build.ts';

// One bounded step of building a candidate's publication evidence; `restart: true` begins the next generation. POST only: an
// operator's session-bound action. The controller checks origin, session and the explicit operate grant before it reads the body.
export async function POST(e: RequestEvent) {
  const controller = await evidenceBuildControllerFor(e); // ORIGINAL Request: the parent's WeakMap composition depends on it.
  return controller.step({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
}
