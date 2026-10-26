import { afterEach, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { load } from '../../../deploy/client/routes/operator/cases/[caseId]/+page.server.ts';
import { setNativeImportComposition } from '../../../src/lib/results-review/native/composition.ts';
import { setOperatorDownloadComposition } from '../../../src/lib/submissions/download/composition.ts';
import { CASE, world } from './fixtures.ts';

afterEach(() => { setNativeImportComposition(null); setOperatorDownloadComposition(null); });
it('page factories receive the original Request and report honest 503 statuses without synthetic subrequests', async () => {
  const w = world();
  const request = new Request(`https://synthetic.invalid/operator/cases/${CASE}`);
  const seen: Request[] = [];
  setNativeImportComposition((a) => { seen.push(a.request); return null; });
  setOperatorDownloadComposition((a) => { seen.push(a.request); return null; });
  const headers: Record<string, string> = {};
  const event = { request, url: new URL(request.url), params: { caseId: CASE }, locals: { identity: w.identity },
    setHeaders(h: Record<string, string>) { Object.assign(headers, h); } } as unknown as RequestEvent;
  const data = await load(event);
  expect(seen).toHaveLength(2);
  expect(seen.every((r) => r === request)).toBe(true);
  expect(data.submissionFailure).toMatchObject({ status: 503, code: 'operator-download-unavailable' });
  expect(data.candidateFailure).toMatchObject({ status: 503, code: 'import-unavailable' });
  expect(data.submissions).toEqual([]);
  expect(data.candidates).toEqual([]);
  expect(headers['cache-control']).toBe('private, no-store');
});
