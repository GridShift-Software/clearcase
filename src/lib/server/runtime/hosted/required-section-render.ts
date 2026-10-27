// This is a display check, not another package validator. Only the actual hosted chronology page is supported at this
// revision. In particular, the local pilot's richer views and the overview's summary do not render required analysis.
// The registered integrity datasets are not views: each is checked against its own contract instead (ADR 0012).
import { render } from 'svelte/server';
import ChronologyPage from '../../../../../deploy/client/routes/cases/[caseId]/views/[resultsVersion]/chronology/+page.svelte';
import type { Candidate } from '../../../case-package/candidate.ts';
import { INTEGRITY_DATASETS, isIntegrityKey, REQUIRED_DATASETS, type IntegrityKey } from '../../../case-package/registry.ts';
import { carriesMeta, metaReconciles, metaSectionV2, type MetaSectionV2 } from '../../../case-package/meta-integrity.ts';
import { sourceLayoutRoundTrips } from '../../../case-package/source-layout.ts';
import type { RequiredSectionState } from '../../../publication/hosted/ports.ts';
import type { StagedProjection } from '../../../results/hosted/read-model.ts';
import type { ResultsVersion } from '../contracts.ts';
import type { ChronologyListRow } from '../../../views/hosted/types.ts';
import type { ChronologyData } from '../../../views/hosted/model.ts';
import { optionsOf, queryFromParams, queryRows, statusOptions } from '../../../local-case/chronology.ts';
import { caseHref, notesHref, originalHref } from '../../../views/hosted/paths.ts';

type Counts = Readonly<Record<string, number>>;

const INTEGRITY_CHECKS: Record<IntegrityKey, (c: Candidate, counts: Counts) => boolean> = {
  // Validation only warns about a META disagreement, and skips a count it has no records for, so no diagnostic is not a
  // verdict: every count is derived from the records here. A diagnostic is still a veto.
  meta: (c, counts) => !counts.V5_META_COUNT_DISAGREEMENT && metaReconciles(c.datasetKeys().map((k) => c.dataset(k)!)),
  'source-layout': (c) => sourceLayoutRoundTrips(c.datasetKeys().map((k) => c.dataset(k)!)),
};

/**
 * Must be called only with the canonical validator's accepted candidate, the uncapped diagnostic counts of that same
 * validation and the freshly verified projection.
 */
export async function renderRequiredSections(a: {
  candidate: Candidate;
  projection: StagedProjection;
  originals: ReadonlyMap<string, string>;
  counts: Counts;
}): Promise<readonly { key: string; state: RequiredSectionState }[]> {
  const c = a.candidate;
  // The format has file/envelope required flags, not an invented feature-list extension. Chronology is also required
  // by the canonical registry even if an attacker removes its manifest entry. Any dataset carrying the META root is checked too, even where the converter demoted it to an optional opaque dataset.
  const keys = new Set([...REQUIRED_DATASETS, ...c.manifest.files.filter((f) => f.required).map((f) => f.key ?? f.path),
    ...c.datasetKeys().filter((k) => carriesMeta(c.dataset(k)!))]);
  const out: { key: string; state: RequiredSectionState }[] = [];
  for (const key of [...keys].sort()) {
    const env = c.dataset(key);
    if (!env) { out.push({ key, state: 'missing' }); continue; }
    if (isIntegrityKey(key) && env.schema === INTEGRITY_DATASETS[key].schema) {
      out.push({ key, state: INTEGRITY_CHECKS[key](c, a.counts) ? 'integrity-verified' : 'invalid' }); continue;
    }
    if (key !== 'chronology' || env.schema !== 'v5.chronology@1') {
      out.push({ key, state: 'unsupported' }); continue;
    }
    const rows = JSON.parse(a.projection.chronologyJson) as ChronologyListRow[];
    const query = queryFromParams(new URLSearchParams());
    const chronology: ChronologyData = {
      resultsVersion: c.resultsVersion as ResultsVersion, total: rows.length, query, search: '',
      items: queryRows(rows, query).map((r) => ({
        ref: r.ref, date: r.date, docType: r.docType, bundle: r.bundle, title: r.subject || r.filename,
        sender: r.sender, excerpt: r.excerpt, amount: r.amount, textStatus: r.textStatus, parentRef: r.parentRef, file: r.file,
        originalHref: r.file === 'present' && a.originals.has(r.ref) ? originalHref(c.caseId, a.originals.get(r.ref)!) : null,
        originalAssetId: r.file === 'present' ? a.originals.get(r.ref) ?? null : null,
      })),
      options: { bundles: optionsOf(rows, 'bundle'), types: optionsOf(rows, 'docType'), statuses: statusOptions(rows) },
      failed: [], originals: 'available', // canonical imported rows only; no external document providers participate
    };
    try {
      const page = await render(ChronologyPage, { props: { data: {
        caseId: c.caseId, label: c.manifest.case.label ?? c.caseId, caseHref: caseHref(c.caseId),
        notesHref: notesHref(c.caseId), chronology,
      } } });
      // The real page's ready marker and every projected row must exist, including the genuine empty-state table.
      const shown = page.body.includes('data-view="chronology"') && page.body.includes('<table aria-label="Chronology">')
        && rows.every((r) => page.body.includes(`data-ref="${r.ref}"`));
      out.push({ key, state: shown ? 'valid' : 'invalid' });
    } catch { out.push({ key, state: 'invalid' }); }
  }
  return out;
}

/**
 * The META section of a snapshot v2 candidate (ADR-0014, Proposed), derived from the candidate's own records and the validation that
 * accepted it: `integrity-verified`, `disagrees` with the exact differing counts, or `invalid`. Null when the candidate carries no
 * registered META, which the v1 renderer above handles. It is a separate entry point and `renderRequiredSections` is unchanged, so a v1
 * candidate's META discrepancy is still `invalid`.
 */
export function metaSectionOf(a: {
  candidate: Candidate;
  validation: Readonly<{ validatorVersion: string; diagnosticsSha256: string; warningFingerprints: readonly string[] }>;
  counts: Counts;
}): MetaSectionV2 | null {
  const c = a.candidate, env = c.dataset(INTEGRITY_DATASETS.meta.key);
  if (!env || env.schema !== INTEGRITY_DATASETS.meta.schema) return null;
  return metaSectionV2(c.datasetKeys().map((k) => c.dataset(k)!), {
    binding: { resultsVersion: c.resultsVersion, manifestSha256: c.manifestSha256, validatorVersion: a.validation.validatorVersion, diagnosticsSha256: a.validation.diagnosticsSha256 },
    warningFingerprints: a.validation.warningFingerprints, diagnostics: a.counts.V5_META_COUNT_DISAGREEMENT ?? 0,
  });
}
