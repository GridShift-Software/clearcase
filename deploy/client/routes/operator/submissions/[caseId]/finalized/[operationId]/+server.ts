import type { RequestEvent } from '@sveltejs/kit';
import { operatorDownloadControllerFor } from '$lib/submissions/download';

// One finalized submission: its immutable manifest, its identity and the paths to the manifest and the PDF.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await operatorDownloadControllerFor(e)).read(at(e));
