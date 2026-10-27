import type { RequestEvent } from '@sveltejs/kit';
import { readCase } from './case.server';

// These section indexes do not exist; authorize the case before returning a recovery link.
export async function missingIndex({ locals, params }: RequestEvent): Promise<Response> {
  const { caseId, info } = await readCase(locals, (params as Record<string, string | undefined>).caseId);
  const message = info.publication.kind === 'published' ? 'This page was not found.' : 'Results are not published yet, or this page was not found.';
  return new Response(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head><body><main><h1>Page not found</h1><p>${message}</p><p><a href="/cases/${encodeURIComponent(caseId)}">Back to case</a></p></main></body></html>`, {
    status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}
