// Coverage of a sealed evidence run against its candidate's immutable link (U8 integration contract; U10; U14). Hosted-safe: pure TypeScript
// over the evidence reader.
//
// The link's coverage was built at import from the verified package and the finalized submission, and its digest binds it, so it is the
// complete expected mapping: every package asset is either a mapped file (with the submission asset, sha256 and size it was matched to) or
// an unavailable one (missing, or embedded in another). A run covers its candidate only when:
//   - its `original/` items are exactly one per distinct mapped submission asset, each with that asset's sha256 and size;
//   - its `preview/` items are exactly one per package asset, except a missing asset nothing cites, which has none;
//   - each such missing asset has instead its authentic missing-original warning (`missingOriginalsOf`: bound fingerprint, the validator's own
//     diagnostic, and that diagnostic in the run), and no other asset has one.
// Omissions, extras and duplicates all refuse. Nothing here trusts the run's own count: the counts compared are the coverage's.
import type { ImportLinkCoverage } from '../../server/runtime/hosted/alpha-contracts.ts';
import { PAGE_SIZE } from './evidence/index.ts';
import type { EvidenceKind, EvidenceReader } from './ports.ts';
import type { AssetBinding } from './asset-policy.ts';
import { checkEvidenceItem, type CheckedEvidenceItem } from './rules.ts';
import { warningsOf, type EvidenceClaim } from './signoff-evidence.ts';

export type CoverageFault = 'originals' | 'previews' | 'missing' | 'rows';

async function every(reader: EvidenceReader, x: EvidenceClaim, kind: EvidenceKind, expected: number): Promise<CheckedEvidenceItem[] | null> {
  const out: CheckedEvidenceItem[] = [];
  let after: string | null = null;
  for (let reads = 0; reads <= Math.ceil(expected / PAGE_SIZE) + 1; reads++) {
    const rows = await reader.page({ clientId: x.clientId as never, caseId: x.caseId as never, candidateId: x.candidateId, generation: x.generation, root: x.root, after, kind, limit: PAGE_SIZE });
    if (rows === null) return null;
    for (const row of rows) {
      const item = checkEvidenceItem(row, x);
      if (!item || item.observation.kind !== kind) return null;
      out.push(item);
    }
    if (rows.length < PAGE_SIZE) return out;
    after = rows[rows.length - 1]!.key;
  }
  return null;
}

/**
 * Null when the run covers the coverage exactly, otherwise the first fault. `counts` are the snapshot's counts of the run's items, used only to
 * bound the reads; the comparison is with the coverage. A fault of the reader rejects.
 */
export async function coverageFault(reader: EvidenceReader, x: EvidenceClaim, coverage: ImportLinkCoverage, counts: { original: number; preview: number; warning: number }, binding: AssetBinding): Promise<CoverageFault | null> {
  const expected = new Map<string, { sha256: string; size: number }>();
  for (const m of coverage.mappedOriginals) {
    const known = expected.get(m.submissionAssetId);
    if (known && (known.sha256 !== m.sha256 || known.size !== m.size)) return 'originals';
    expected.set(m.submissionAssetId, { sha256: m.sha256, size: m.size });
  }
  const originals = await every(reader, x, 'original', counts.original);
  if (!originals) return 'rows';
  const seen = new Set<string>();
  for (const o of originals) {
    if (o.observation.kind !== 'original') return 'rows';
    const want = expected.get(o.observation.assetId);
    if (!want || seen.has(o.observation.assetId) || want.sha256 !== o.observation.sha256 || want.size !== o.observation.size) return 'originals';
    seen.add(o.observation.assetId);
  }
  if (seen.size !== expected.size) return 'originals';

  const facts = await warningsOf({ reader }, x, counts.warning, binding);
  if (!facts) return 'missing';
  const missingRefs = new Set(coverage.unavailableOriginals.filter((u) => u.kind === 'missing').map((u) => u.ref));
  const exempt = new Set<string>();
  for (const m of facts.missing) {
    if (!missingRefs.has(m.assetId) || exempt.has(m.assetId)) return 'missing';
    exempt.add(m.assetId);
  }
  const refs = [...coverage.mappedOriginals.flatMap((m) => m.packageRefs), ...coverage.unavailableOriginals.map((u) => u.ref)];
  if (new Set(refs).size !== refs.length) return 'previews';
  const previews = await every(reader, x, 'preview', counts.preview);
  if (!previews) return 'rows';
  const shown = new Set<string>();
  for (const p of previews) {
    if (p.observation.kind !== 'preview' || shown.has(p.observation.assetId) || exempt.has(p.observation.assetId)) return 'previews';
    shown.add(p.observation.assetId);
  }
  return refs.every((r) => shown.has(r) !== exempt.has(r)) && shown.size + exempt.size === refs.length ? null : 'previews';
}
