import type { RequestEvent } from '@sveltejs/kit';
import { nativeImportControllerFor } from '$lib/results-review/native';

// The chunked import (see src/lib/results-review/native/controller.ts). Authority is decided before any body byte is read, as for the
// one-request import; a candidate stays private and nothing here publishes.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const POST = async (e: RequestEvent) => (await nativeImportControllerFor(e)).sweepStaged(at(e));
