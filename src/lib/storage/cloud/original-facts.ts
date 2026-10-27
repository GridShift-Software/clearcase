// The verified facts about a case's originals, read from the case's own finalized originals in D1 and their R2 objects. This is
// the hosted counterpart of local-case's `verifyOriginals` (case-package/originals.ts): the status of an original is something
// the importing side observed, not something a caller says. Nothing here takes a status, a flag or a projection as input.
//
// The case folder, hosted. A package asset key is a local alias, not an upload identity: the local import locates an original
// by its indexed path and fingerprint, and several keys may index one path. So the hosted folder is the set of the case's own
// finalized originals with their case-relative paths:
//   - Intake originals (GRS-137): a FINALIZED submission of this client and case (`submissions_upload` finalized, its
//     `submissions_revision` and `submissions_file`), whose asset (`sub-<operationId>`) GRS-115 bound to the same bytes
//     (`rs_case_original` plus a finalized `rs_original_upload` of the same case, asset and bytes). The path is the submission
//     file's `path`; the association's `filename` (the basename) is not used. A reserved, stored or received upload is not in
//     the folder, whatever GRS-115 already bound.
//   - Set originals (U16): each file of a SEALED set of this client and case (`submissions_set` sealed, the set's revision and
//     its `submissions_file` rows, each matched to its member upload, finalized), bound by GRS-115 the same way. The revision
//     id is the set's revision, so a selection by revision takes every file of the set. A set still sealing is not in the folder.
//   - Direct originals (the GRS-115 upload contract without an intake submission): the case's own finalized association whose
//     asset id is the package key and whose `filename` is the case-relative path. An association whose asset has any intake
//     declaration is never direct, so a reserved intake upload cannot enter this way.
// Another case's or client's rows, a hash that exists only globally (`rs_original`, `orig/<sha256>`) and a bare association
// row are not in the folder. No lineage is inferred from a hash alone: an original is found by its path first.
//
// For each file asset of the package (key, indexed path, SHA-256, size, media type):
//   1. Locate: folder originals at exactly the indexed path (direct ones only under this key); else, when exactly one real path
//      of the folder folds (NFC and lower case) to it, the originals at that path (`case-mismatch`, with the real name); else
//      none or an ambiguous fold: unavailable, as `locate` reports it.
//   2. Revision: every located original must have one fingerprint. Two finalized revisions at the located path with different
//      bytes are not resolved by picking one: the import needs an exact `RequiredOriginalLink` for that key (refused
//      `original-link-required` without one). A supplied link must name exactly one located intake original (asset id, stored
//      path, SHA-256, size, path match and package path), else the import is refused (`integrity`).
//   3. Fingerprint: the original's SHA-256 and size are the indexed ones, else a genuine mismatch (refused, never relabelled).
//   4. Bytes: the R2 object is read whole and hashed against that fingerprint (`verifiedRead`). Absent: unavailable. Changed at
//      rest, or an object key other than `orig/<sha256>`: a genuine mismatch. Unreachable: retryable `storage-unavailable`.
//   5. Sniff: the first 1,024 bytes decide `downloadOnly` with the same `contentContradictsType` as local.
import { contractError } from '../../server/runtime/errors.ts';
import { contentContradictsType } from '../../case-package/media.ts';
import { foldPath } from '../../case-package/paths.ts';
import type { FileAssetClaim, OriginalFact, OriginalFacts } from '../../results/hosted/project.ts';
import type { StagedAsset } from '../../results/hosted/read-model.ts';
import type { CaseId, ClientId } from '../../server/runtime/contracts.ts';
import type { RequiredOriginalLink } from '../../server/runtime/hosted/alpha-contracts.ts';
import type { CloudD1 } from './bindings.ts';
import type { OpenStorage } from './access.ts';
import { originalKey } from './keys.ts';
import { verifiedRead, type ObjectRead } from './objects.ts';

export type { RequiredOriginalLink };
/** Where a fact came from: the exact finalized intake originals (one fingerprint) or the direct association. */
export type OriginalAttribution = { pathMatch: 'literal' | 'case-nfc-unique'; storedPath: string; sha256: string; size: number; sources: readonly ({ kind: 'submission'; submissionAssetId: string; revisionId: string } | { kind: 'direct'; assetId: string })[] };
export type OriginalFactsRefusal = 'integrity' | 'over-budget' | 'original-link-required';
export type OriginalFactsResult =
  | { kind: 'ok'; facts: OriginalFacts; attribution: ReadonlyMap<string, OriginalAttribution> }
  | { kind: 'refused'; reason: OriginalFactsRefusal; problems: string[] };

/** One finalized original of the case folder. */
export interface FolderOriginal { source: 'submission' | 'direct'; assetId: string; path: string; sha256: string; size: number; originalSize: number; objectKey: string; revisionId: string | null }
const CONCURRENCY = 8;
const HEX = /^[0-9a-f]{64}$/;
const unreachable = (): never => { throw contractError('storage-unavailable', true); };

/** The case folder: this client's and case's finalized originals (intake and direct), each with its case-relative path. */
export async function caseFolder(db: CloudD1, clientId: ClientId, caseId: CaseId): Promise<FolderOriginal[]> {
  const finalizedUpload = "EXISTS (SELECT 1 FROM rs_original_upload x WHERE x.case_id = c.case_id AND x.asset_id = c.asset_id AND x.sha256 = c.sha256 AND x.state = 'finalized')";
  const { results } = await db.prepare(`
    SELECT 'submission' AS source, f.asset_id AS assetId, f.path AS path, f.sha256 AS sha256, f.size AS size, o.size AS originalSize, o.object_key AS objectKey, f.revision_id AS revisionId
      FROM submissions_file f
      JOIN submissions_revision r ON r.client_id = f.client_id AND r.case_id = f.case_id AND r.revision_id = f.revision_id
      JOIN submissions_upload u ON u.client_id = r.client_id AND u.case_id = r.case_id AND u.operation_id = r.operation_id
        AND u.asset_id = f.asset_id AND u.path = f.path AND u.sha256 = f.sha256 AND u.size = f.size AND u.state = 'finalized'
      JOIN rs_case_original c ON c.case_id = f.case_id AND c.asset_id = f.asset_id AND c.sha256 = f.sha256
      JOIN rs_original o ON o.sha256 = c.sha256
      WHERE f.client_id = ? AND f.case_id = ? AND ${finalizedUpload}
    UNION ALL
    SELECT 'direct', c.asset_id, c.filename, c.sha256, o.size, o.size, o.object_key, NULL
      FROM rs_case_original c JOIN rs_original o ON o.sha256 = c.sha256
      WHERE c.case_id = ? AND ${finalizedUpload}
        AND NOT EXISTS (SELECT 1 FROM submissions_upload u WHERE u.case_id = c.case_id AND u.asset_id = c.asset_id)
    UNION ALL
    SELECT 'submission', f.asset_id, f.path, f.sha256, f.size, o.size, o.object_key, f.revision_id
      FROM submissions_file f
      JOIN submissions_revision r ON r.client_id = f.client_id AND r.case_id = f.case_id AND r.revision_id = f.revision_id
      JOIN submissions_set s ON s.client_id = r.client_id AND s.case_id = r.case_id AND s.set_id = r.operation_id AND s.state = 'sealed'
      JOIN submissions_set_member m ON m.client_id = s.client_id AND m.case_id = s.case_id AND m.set_id = s.set_id AND m.path_key = f.path_key
      JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
        AND u.asset_id = f.asset_id AND u.path = f.path AND u.sha256 = f.sha256 AND u.size = f.size AND u.state = 'finalized'
      JOIN rs_case_original c ON c.case_id = f.case_id AND c.asset_id = f.asset_id AND c.sha256 = f.sha256
      JOIN rs_original o ON o.sha256 = c.sha256
      WHERE f.client_id = ? AND f.case_id = ? AND ${finalizedUpload}`)
    .bind(clientId, caseId, caseId, clientId, caseId).all<FolderOriginal>().catch(unreachable);
  return results;
}

type Index = { byPath: Map<string, FolderOriginal[]>; byFold: Map<string, FolderOriginal[]>; foldPaths: Map<string, Set<string>> };
function index(folder: readonly FolderOriginal[]): Index {
  const byPath = new Map<string, FolderOriginal[]>(), byFold = new Map<string, FolderOriginal[]>(), foldPaths = new Map<string, Set<string>>();
  const add = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const xs = m.get(k); if (xs) xs.push(v); else m.set(k, [v]); };
  for (const o of folder) {
    const f = foldPath(o.path);
    add(byPath, o.path, o);
    add(byFold, f, o);
    foldPaths.set(f, (foldPaths.get(f) ?? new Set()).add(o.path));
  }
  return { byPath, byFold, foldPaths };
}
/** `locate` over the hosted folder: the originals at the indexed path, or at the one real path that folds to it. */
function locate(ix: Index, a: { key: string; path: string }): { found: FolderOriginal[]; match: 'literal' | 'case-nfc-unique' } | null {
  const mine = (xs: readonly FolderOriginal[] | undefined) => (xs ?? []).filter((o) => o.source === 'submission' || o.assetId === a.key);
  const literal = mine(ix.byPath.get(a.path));
  if (literal.length) return { found: literal, match: 'literal' };
  const f = foldPath(a.path);
  const folded = mine(ix.byFold.get(f));
  return folded.length && ix.foldPaths.get(f)?.size === 1 ? { found: folded, match: 'case-nfc-unique' } : null;
}
const print = (o: { sha256: string; size: number }) => `${o.sha256}:${o.size}`;

/** A caller's links, checked for shape (they are request data) and indexed by package key. Null when any is malformed or a key repeats. */
function linksByKey(links: readonly RequiredOriginalLink[] | undefined): Map<string, RequiredOriginalLink> | null {
  const out = new Map<string, RequiredOriginalLink>();
  if (links === undefined) return out;
  if (!Array.isArray(links)) return null;
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && v.isWellFormed();
  for (const l of links as readonly unknown[]) {
    const x = l as Partial<RequiredOriginalLink> | null;
    if (!x || typeof x !== 'object' || !Array.isArray(x.packageRefs) || x.packageRefs.length === 0 || !x.packageRefs.every(text) || !text(x.packagePath) || !text(x.storedPath) || !text(x.submissionAssetId)
      || typeof x.sha256 !== 'string' || !HEX.test(x.sha256) || !Number.isSafeInteger(x.size) || (x.pathMatch !== 'literal' && x.pathMatch !== 'case-nfc-unique')) return null;
    for (const k of x.packageRefs) { if (out.has(k)) return null; out.set(k, x as RequiredOriginalLink); }
  }
  return out;
}

/** `folder`, when given, is this case's `caseFolder` read by the same caller in the same phase; the bytes are still read here. */
export async function readOriginalFacts(s: Pick<OpenStorage, 'db' | 'bucket' | 'budgets' | 'clientId'>, caseId: CaseId, assets: readonly FileAssetClaim[], links?: readonly RequiredOriginalLink[], folder?: readonly FolderOriginal[]): Promise<OriginalFactsResult> {
  const linked = linksByKey(links);
  if (!linked) return { kind: 'refused', reason: 'integrity', problems: ['an original link is malformed or names a package key twice'] };
  const keys = new Set(assets.map((a) => a.key));
  const stray = [...linked.keys()].filter((k) => !keys.has(k)).sort();
  if (stray.length) return { kind: 'refused', reason: 'integrity', problems: stray.slice(0, 20).map((k) => `original link for ${k}: the package has no file asset ${k}`) };
  if (assets.length === 0) return { kind: 'ok', facts: new Map(), attribution: new Map() };
  const ix = index(folder ?? await caseFolder(s.db, s.clientId, caseId));

  const facts = new Map<string, OriginalFact>(), attribution = new Map<string, OriginalAttribution>();
  const refusals: { key: string; reason: OriginalFactsRefusal; problem: string }[] = [];
  const reads = new Map<string, Promise<ObjectRead>>();
  const one = async (a: FileAssetClaim) => {
    const link = linked.get(a.key);
    const at = locate(ix, a);
    if (!at) {
      if (link) refusals.push({ key: a.key, reason: 'integrity', problem: `original link for ${a.key}: no finalized original of this case is at that path` });
      return;
    }
    let found = at.found;
    if (link) {
      const exact = found.filter((o) => o.source === 'submission' && o.assetId === link.submissionAssetId && o.path === link.storedPath && o.sha256 === link.sha256 && o.size === link.size);
      if (exact.length !== 1 || link.packagePath !== a.path || link.pathMatch !== at.match) { refusals.push({ key: a.key, reason: 'integrity', problem: `original link for ${a.key}: it does not name one finalized original of this case at that path` }); return; }
      found = exact;
    } else if (new Set(found.map(print)).size > 1) {
      const ids = found.map((o) => o.assetId).sort().join(', ');
      refusals.push({ key: a.key, reason: 'original-link-required', problem: `original ${a.key}: finalized revisions with different bytes are at ${found[0]!.path} (${ids}); an import link must name one` });
      return;
    }
    const o = found[0]!;
    if (o.sha256 !== a.sha256 || o.size !== a.size || o.originalSize !== o.size) { refusals.push({ key: a.key, reason: 'integrity', problem: `original ${a.key}: size or sha256 differs from the asset index` }); return; }
    if (o.objectKey !== originalKey(o.sha256)) { refusals.push({ key: a.key, reason: 'integrity', problem: `original ${a.key}: the object is not under its content key` }); return; }
    let read = reads.get(o.sha256);
    if (!read) { read = verifiedRead(s.bucket, o.objectKey, { size: o.size, sha256: o.sha256 }, s.budgets.maxBufferedObjectBytes); reads.set(o.sha256, read); }
    const r = await read;
    if (r.kind === 'unreachable') unreachable();
    if (r.kind === 'missing') return;
    if (r.kind === 'over-budget') { refusals.push({ key: a.key, reason: 'over-budget', problem: `original ${a.key}: over maxBufferedObjectBytes` }); return; }
    if (r.kind !== 'ok') { refusals.push({ key: a.key, reason: 'integrity', problem: `original ${a.key}: the stored bytes differ from the recorded size or sha256` }); return; }
    const exact = at.match === 'literal';
    facts.set(a.key, { path: exact ? a.path : o.path, sha256: a.sha256, size: a.size, mediaType: a.mediaType, status: exact ? 'verified' : 'case-mismatch', downloadOnly: contentContradictsType(a.mediaType, r.bytes.subarray(0, 1024)) });
    attribution.set(a.key, {
      pathMatch: at.match, storedPath: o.path, sha256: o.sha256, size: o.size,
      sources: found.map((x) => (x.source === 'submission' ? { kind: 'submission' as const, submissionAssetId: x.assetId, revisionId: x.revisionId! } : { kind: 'direct' as const, assetId: x.assetId })),
    });
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assets.length) }, async () => { while (next < assets.length) await one(assets[next++]!); }));
  if (refusals.length) {
    refusals.sort((x, y) => (x.key < y.key ? -1 : 1));
    const reason = refusals.some((x) => x.reason === 'integrity') ? 'integrity' : refusals.some((x) => x.reason === 'original-link-required') ? 'original-link-required' : 'over-budget';
    return { kind: 'refused', reason, problems: refusals.slice(0, 20).map((x) => x.problem) };
  }
  return { kind: 'ok', facts, attribution };
}

/** A stored model's claim that an original was checked: the rows of the asset index that say `verified` or `case-mismatch`. */
export type OriginalClaim = { key: string; status: 'verified' | 'case-mismatch'; realPath: string; sha256: string; size: number; downloadOnly: boolean };
/** The claims of a stored model, or null when a claim row is malformed (an `unavailable` row asserts nothing and is not a claim). */
export function originalClaims(stored: readonly StagedAsset[]): OriginalClaim[] | null {
  const out: OriginalClaim[] = [];
  for (const row of stored) {
    if (row.kind !== 'file' || row.status === 'unavailable') continue;
    if ((row.status !== 'verified' && row.status !== 'case-mismatch') || typeof row.real_path !== 'string' || typeof row.sha256 !== 'string' || !HEX.test(row.sha256) || !Number.isSafeInteger(row.size)) return null;
    out.push({ key: row.key, status: row.status, realPath: row.real_path, sha256: row.sha256, size: row.size!, downloadOnly: row.download_only === 1 });
  }
  return out;
}

/**
 * A stored model's claims about originals, checked as they stand now. A claim of `verified` or `case-mismatch` says the bytes
 * were checked, so it must still hold: it agrees with the package's asset index (fingerprint, and the name rule its status
 * names), a finalized original of this case's folder at exactly the claimed real path has exactly those bytes, the R2 object
 * hashes to them now, and its sniff gives the same download-only. A claim of `unavailable` asserts nothing and is kept as
 * stored. The folder is not located again: an original uploaded later (even a new revision at the same path) does not
 * unverify an immutable version. Each distinct original is read once per call. Returns the facts to derive the model from,
 * or null when a claim no longer holds. The caller bounds the work before it calls (verifyVersion's plan).
 */
export async function checkClaims(s: Pick<OpenStorage, 'db' | 'bucket' | 'budgets' | 'clientId'>, caseId: CaseId, assets: readonly FileAssetClaim[], claims: readonly OriginalClaim[]): Promise<OriginalFacts | null> {
  const out = new Map<string, OriginalFact>();
  if (claims.length === 0) return out;
  const indexed = new Map(assets.map((a) => [a.key, a]));
  const { byPath } = index(await caseFolder(s.db, s.clientId, caseId));
  const reads = new Map<string, Promise<ObjectRead>>();
  for (const c of claims) {
    const a = indexed.get(c.key);
    if (!a || a.sha256 !== c.sha256 || a.size !== c.size) return null;
    if (c.status === 'verified' ? c.realPath !== a.path : c.realPath === a.path || foldPath(c.realPath) !== foldPath(a.path)) return null;
    const o = (byPath.get(c.realPath) ?? []).find((x) => x.sha256 === c.sha256 && x.size === c.size && x.originalSize === c.size && (x.source === 'submission' || x.assetId === c.key));
    if (!o || o.objectKey !== originalKey(o.sha256)) return null;
    let read = reads.get(o.sha256);
    if (!read) { read = verifiedRead(s.bucket, o.objectKey, { size: o.size, sha256: o.sha256 }, s.budgets.maxBufferedObjectBytes); reads.set(o.sha256, read); }
    const r = await read;
    if (r.kind === 'unreachable') unreachable();
    if (r.kind !== 'ok') return null;
    const downloadOnly = contentContradictsType(a.mediaType, r.bytes.subarray(0, 1024));
    if (downloadOnly !== c.downloadOnly) return null;
    out.set(c.key, { path: c.realPath, sha256: c.sha256, size: c.size, mediaType: a.mediaType, status: c.status, downloadOnly });
  }
  return out;
}
