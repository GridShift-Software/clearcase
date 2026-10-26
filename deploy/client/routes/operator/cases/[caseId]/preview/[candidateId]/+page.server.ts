import { error, type RequestEvent } from '@sveltejs/kit';
import { codeOf } from '$lib/server/runtime/errors';
import { refuse } from '$lib/server/runtime/hosted/http';
import { privatePreviewFor, type PreviewOriginal, type PrivatePreview } from '$lib/server/runtime/hosted/private-preview';
import { optionsOf, paramsFromQuery, queryFromParams, queryRows, statusOptions } from '$lib/local-case/chronology';
import { originalHref } from '$lib/views/hosted/paths';

// The operator's private preview of one exact current candidate, before any sign-off or publication: its stored
// overview, chronology and the originals its link mapped. Authority is the candidate reader's (operate and read-preview,
// fenced again before release); originals open through the case's original routes as their own requests. The published
// case routes are unchanged and still answer 404 for this version.
export async function load(e: RequestEvent) {
  e.setHeaders({ 'cache-control': 'private, no-store' });
  const who = e.locals.identity;
  if (!who || who.kind !== 'verified') error(401, { message: 'Sign in to continue.', code: 'unauthenticated' });
  // The ORIGINAL request, never a clone or a synthetic SSR fetch request.
  const reader = privatePreviewFor({ request: e.request });
  const p = e.params as Record<string, string>;
  if (who.principal.kind !== 'staff') {
    // Refused before the reader runs, so this denial is recorded here (best effort), and no candidate is read.
    await reader?.denied({ caseId: p.caseId, candidateId: p.candidateId });
    error(403, { message: 'This preview requires explicit operator access.', code: 'forbidden' });
  }
  if (!reader) error(503, { message: 'The private preview is not available on this deployment yet.', code: 'preview-unavailable' });
  let preview: PrivatePreview;
  try { preview = await reader!.read({ caseId: p.caseId, candidateId: p.candidateId }); }
  catch (x) {
    if (codeOf(x) === 'integrity') error(503, { message: 'The stored candidate failed its integrity check, so it is not shown.', code: 'integrity' });
    refuse(x);
  }
  const v = preview!, o = v.overview, caseId = v.caseId;
  const links = (x: PreviewOriginal) => ({ viewHref: x.inline ? `${originalHref(caseId, x.assetId)}/view` : null, downloadHref: `${originalHref(caseId, x.assetId)}?download=1` });
  const byRef = new Map(v.originals.map((x) => [x.ref, x]));
  const query = queryFromParams(e.url.searchParams);
  const items = queryRows(v.rows, query).map((r) => {
    const x = r.file === 'present' ? byRef.get(r.ref) : undefined;
    return { ref: r.ref, date: r.date, docType: r.docType, bundle: r.bundle, title: r.subject || r.filename, sender: r.sender, excerpt: r.excerpt, amount: r.amount,
      textStatus: r.textStatus, parentRef: r.parentRef, file: r.file, assetId: x?.assetId ?? null, ...(x ? links(x) : { viewHref: null, downloadHref: null }) };
  });
  return {
    published: false as const,
    caseId, candidateId: v.candidateId, linkId: v.linkId, origin: v.origin, linkedAt: v.linkedAt, resultsVersion: v.resultsVersion,
    manifestSha256: v.manifestSha256, packageInputRevisionId: v.packageInputRevisionId, submissionRevisionId: v.submissionRevisionId,
    submissionManifestSha256: v.submissionManifestSha256, attribution: v.attribution,
    workbenchHref: `/operator/cases/${encodeURIComponent(caseId)}`,
    overview: {
      caseName: o.caseLabel || caseId, matterTitle: o.matter?.title || null, producer: o.producer, created: o.created, inputKind: o.inputKind,
      documents: v.rows.length, counts: { emails: o.counts.emails, invoices: o.counts.invoices, attachments: o.counts.attachments, withoutText: o.counts.byTextStatus.none ?? 0 },
      dates: o.dates, originals: o.originals,
      // dataset names (bundles, types) never become object keys in page data
      byBundle: Object.entries(o.counts.byBundle), byDocType: Object.entries(o.counts.byDocType),
    },
    originals: v.originals.map((x) => ({ ref: x.ref, assetId: x.assetId, path: x.path, mediaType: x.mediaType, size: x.size, ...links(x) })),
    unavailable: v.unavailable.map((u) => ({ ...u })),
    chronology: { total: v.rows.length, items, query, search: paramsFromQuery(query).toString(),
      options: { bundles: optionsOf(v.rows, 'bundle'), types: optionsOf(v.rows, 'docType'), statuses: statusOptions(v.rows) } },
  };
}
