import { error, type RequestEvent } from '@sveltejs/kit';
import { operatorDownloadControllerFor } from '$lib/submissions/download';
import { nativeImportControllerFor } from '$lib/results-review/native';
import type { OperatorSubmissionView } from '$lib/submissions/download';
import type { LinkedCandidate } from '$lib/results-review/native/ports.ts';

export async function load(e: RequestEvent) {
  e.setHeaders({ 'cache-control': 'private, no-store' });
  const who = e.locals.identity;
  if (!who || who.kind !== 'verified') error(401, 'Sign in to continue.');
  if (who.principal.kind !== 'staff') error(403, 'This workbench requires explicit operator access.');
  const at = { request: e.request, url: e.url, params: e.params as Record<string, string>, identity: who };
  // Controller factories see the ORIGINAL request, never a clone or a synthetic SSR fetch request.
  const downloads = await (await operatorDownloadControllerFor(e)).list(at);
  const submissions = await downloads.json() as { submissions?: OperatorSubmissionView[]; code?: string; message?: string };
  if (!downloads.ok && downloads.status !== 503) error(downloads.status, submissions.message ?? 'Submission access refused.');
  const results = await (await nativeImportControllerFor(e)).list(at);
  const candidates = await results.json() as { candidates?: LinkedCandidate[]; code?: string; message?: string };
  if (!results.ok && results.status !== 503) error(results.status, candidates.message ?? 'Candidate access refused.');
  return {
    caseId: at.params.caseId,
    submissions: submissions.submissions ?? [], candidates: candidates.candidates ?? [],
    submissionFailure: downloads.ok ? null : { status: downloads.status, code: submissions.code ?? 'unavailable', message: submissions.message ?? 'Submissions unavailable.' },
    candidateFailure: results.ok ? null : { status: results.status, code: candidates.code ?? 'unavailable', message: candidates.message ?? 'Candidates unavailable.' },
  };
}
