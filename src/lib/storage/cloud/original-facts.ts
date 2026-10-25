// The verified facts about a case's originals, read from the case's own D1 association and R2 object. This is the hosted
// counterpart of local-case's `verifyOriginals` (case-package/originals.ts): the status of an original is something the
// importing side observed, not something a caller says. Nothing here takes a status, a flag or a projection as input.
//
// For each file asset of the package (key, indexed path, SHA-256, size, media type) the facts are:
//   1. Association: the case's own finalized original under that asset key (`rs_case_original`, joined to an `rs_original_upload`
//      row of this case that finalized the same bytes). Another case's association, another asset key, or a hash that only exists
//      globally in `rs_original` or `orig/<sha256>` is not an association. None: unavailable (the case folder does not hold it).
//   2. Name: the association's filename is the original's real case-relative path. Equal to the indexed path: exact. Equal after
//      NFC and lower-casing, and no other original of the case folds to the same path: `case-mismatch`, recorded with the real name.
//      Anything else, or an ambiguous fold: unavailable (no file at that path), as `locate` reports it.
//   3. Fingerprint: the association's SHA-256 and size are the indexed ones, else a genuine mismatch (refused, never relabelled).
//   4. Bytes: the R2 object is read whole and hashed against that fingerprint (`verifiedRead`). Absent: unavailable. Changed at
//      rest, or an object key other than `orig/<sha256>`: a genuine mismatch. Unreachable: retryable `storage-unavailable`.
//   5. Sniff: the first 1,024 bytes decide `downloadOnly` with the same `contentContradictsType` as local.
import { contractError } from '../../server/runtime/errors.ts';
import { contentContradictsType } from '../../case-package/media.ts';
import { foldPath } from '../../case-package/paths.ts';
import type { FileAssetClaim, OriginalFact, OriginalFacts } from '../../results/hosted/project.ts';
import type { StagedAsset } from '../../results/hosted/read-model.ts';
import type { CaseId } from '../../server/runtime/contracts.ts';
import type { OpenStorage } from './access.ts';
import { originalKey } from './keys.ts';
import { verifiedRead } from './objects.ts';

export type OriginalFactsResult = { kind: 'ok'; facts: OriginalFacts } | { kind: 'refused'; reason: 'integrity' | 'over-budget'; problems: string[] };
type Association = { asset_id: string; filename: string; sha256: string; size: number; object_key: string };
const CONCURRENCY = 8;
const unreachable = (): never => { throw contractError('storage-unavailable', true); };

export async function readOriginalFacts(s: Pick<OpenStorage, 'db' | 'bucket' | 'budgets'>, caseId: CaseId, assets: readonly FileAssetClaim[]): Promise<OriginalFactsResult> {
  if (assets.length === 0) return { kind: 'ok', facts: new Map() };
  const { results } = await s.db.prepare(`SELECT c.asset_id, c.filename, c.sha256, o.size, o.object_key FROM rs_case_original c JOIN rs_original o ON o.sha256 = c.sha256
    WHERE c.case_id = ? AND EXISTS (SELECT 1 FROM rs_original_upload u WHERE u.case_id = c.case_id AND u.asset_id = c.asset_id AND u.sha256 = c.sha256 AND u.state = 'finalized')`)
    .bind(caseId).all<Association>().catch(unreachable);
  const byAsset = new Map(results.map((r) => [r.asset_id, r]));
  const folded = new Map<string, number>();
  for (const r of results) { const k = foldPath(r.filename); folded.set(k, (folded.get(k) ?? 0) + 1); }

  const facts = new Map<string, OriginalFact>();
  const refusals: { key: string; reason: 'integrity' | 'over-budget'; problem: string }[] = [];
  const reads = new Map<string, ReturnType<typeof verifiedRead>>();
  const one = async (a: FileAssetClaim) => {
    const found = byAsset.get(a.key);
    if (!found) return;
    const exact = found.filename === a.path;
    if (!exact && !(foldPath(found.filename) === foldPath(a.path) && folded.get(foldPath(a.path)) === 1)) return;
    if (found.sha256 !== a.sha256 || found.size !== a.size) { refusals.push({ key: a.key, reason: 'integrity', problem: `original ${a.key}: size or sha256 differs from the asset index` }); return; }
    if (found.object_key !== originalKey(found.sha256)) { refusals.push({ key: a.key, reason: 'integrity', problem: `original ${a.key}: the object is not under its content key` }); return; }
    let read = reads.get(found.sha256);
    if (!read) { read = verifiedRead(s.bucket, found.object_key, { size: found.size, sha256: found.sha256 }, s.budgets.maxBufferedObjectBytes); reads.set(found.sha256, read); }
    const r = await read;
    if (r.kind === 'unreachable') unreachable();
    if (r.kind === 'missing') return;
    if (r.kind === 'over-budget') { refusals.push({ key: a.key, reason: 'over-budget', problem: `original ${a.key}: over maxBufferedObjectBytes` }); return; }
    if (r.kind !== 'ok') { refusals.push({ key: a.key, reason: 'integrity', problem: `original ${a.key}: the stored bytes differ from the recorded size or sha256` }); return; }
    facts.set(a.key, { path: exact ? a.path : found.filename, sha256: a.sha256, size: a.size, mediaType: a.mediaType, status: exact ? 'verified' : 'case-mismatch', downloadOnly: contentContradictsType(a.mediaType, r.bytes.subarray(0, 1024)) });
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assets.length) }, async () => { while (next < assets.length) await one(assets[next++]!); }));
  if (refusals.length) {
    refusals.sort((x, y) => (x.key < y.key ? -1 : 1));
    return { kind: 'refused', reason: refusals.some((x) => x.reason === 'integrity') ? 'integrity' : 'over-budget', problems: refusals.slice(0, 20).map((x) => x.problem) };
  }
  return { kind: 'ok', facts };
}

/**
 * A stored read model's claims about originals, checked against the facts as they are now. A claim of `verified` or
 * `case-mismatch` is an assertion that the bytes were checked, so it must still hold exactly (name, fingerprint, download-only);
 * a claim of `unavailable` asserts nothing and is kept as stored (an original uploaded later does not unverify an immutable version).
 * Returns the facts to derive the model from, or null when a stored claim is no longer true.
 */
export function claimedFacts(stored: readonly StagedAsset[], current: OriginalFacts): OriginalFacts | null {
  const out = new Map<string, OriginalFact>();
  for (const row of stored) {
    if (row.kind !== 'file' || row.status === 'unavailable') continue;
    const now = current.get(row.key);
    if (!now || now.status !== row.status || now.path !== row.real_path || now.sha256 !== row.sha256 || now.size !== row.size || now.downloadOnly !== (row.download_only === 1)) return null;
    out.set(row.key, now);
  }
  return out;
}
