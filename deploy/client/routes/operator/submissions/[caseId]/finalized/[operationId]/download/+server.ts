import type { RequestEvent } from '@sveltejs/kit';
import { operatorDownloadControllerFor } from '$lib/submissions/download';

// The complete one-PDF submission bytes (200, or 206 for one range), audited before any byte is sent.
const at = (e: RequestEvent) => ({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
export const GET = async (e: RequestEvent) => (await operatorDownloadControllerFor(e)).download(at(e));
export const HEAD = async (e: RequestEvent) => (await operatorDownloadControllerFor(e)).download(at(e));
