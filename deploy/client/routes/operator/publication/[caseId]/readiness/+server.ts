import type { RequestEvent } from '@sveltejs/kit';
import { readinessControllerFor } from '$lib/publication/hosted/readiness.ts';

export async function GET(e: RequestEvent) {
  const controller = await readinessControllerFor(e); // ORIGINAL Request: parent's WeakMap composition depends on it.
  return controller.read({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
}
