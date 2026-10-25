import type { RequestEvent } from '@sveltejs/kit';
import { operatorDownloadControllerFor } from '$lib/submissions/download';

// The exact immutable manifest of one finalized submission, as a download-safe attachment.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await operatorDownloadControllerFor(e)).manifest(at(e));
