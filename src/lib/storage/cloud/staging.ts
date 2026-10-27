import type { CaseId, ResultsVersion } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { verifyCandidateBytes } from '../../case-package/verify-bytes.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../case-package/strict-json.ts';
import { preparePackage } from '../../results/hosted/project.ts';
import { projectionDifferences, readModelDigest, type StagedAsset, type StagedProjection } from '../../results/hosted/read-model.ts';
import type { CloudD1, CloudD1Statement, CloudR2Head } from './bindings.ts';
import type { StorageContext } from './context.ts';
import { guard } from './d1.ts';
import { packageKey } from './keys.ts';
import { readOriginalFacts, type RequiredOriginalLink } from './original-facts.ts';
import { writerAccess, type OpenWriter } from './mutation.ts';
import { writeOnce } from './objects.ts';

export type { StagedAsset, StagedProjection };
/**
 * One validated candidate, as the operator import controller (GRS-30) hands it over after the case-package library
 * accepted it: the exact package bytes, the identity the validator computed, its verdict, and the projection it
 * computed (`project()` of local-case/project.server.ts). The projection is a claim, not an input: storage derives the
 * canonical projection from the verified package bytes and the case's own verified original facts with the hosted-safe
 * projector, refuses a claim that differs, and stores and digests only what it derived. The verdict and diagnostics are the import controller's own and are recorded as given.
 */
export interface StageInput {
  caseId: CaseId;
  operationId: string;
  files: ReadonlyMap<string, Uint8Array>;
  identity: { resultsVersion: ResultsVersion; manifestSha256: string };
  validation: { verdict: 'accept' | 'report'; validatorVersion: string; diagnosticsSha256: string; warningFingerprints: readonly string[] };
  projection: StagedProjection;
  /**
   * The immutable import link's `coverage.mappedOriginals` (server/runtime/hosted/alpha-contracts.ts), when the importer holds
   * one. Optional: an original found at its path with one fingerprint needs no link. Required (`original-link-required`) only
   * for a key whose path holds finalized revisions with different bytes; storage never picks one. A link is checked against the
   * case's finalized originals and is never a status: a link that does not name exactly one of them refuses the import.
   */
  originalLinks?: readonly RequiredOriginalLink[];
}
export type StageRefusal = 'over-budget' | 'integrity' | 'wrong-case' | 'unknown-case' | 'inconsistent-projection' | 'version-of-another-case' | 'conflicting-object' | 'over-quota' | 'original-link-required';
export type StageOutcome = { kind: 'stored'; resultsVersion: ResultsVersion; repeated: boolean } | { kind: 'refused'; reason: StageRefusal; detail: readonly string[] };
/**
 * Stores a candidate as an immutable results version: `staging` while its objects and rows are written, `stored` in
 * one guarded batch once every count and object matches. It never publishes: publication is GRS-31's guarded batch.
 * A retry of a staging version starts a new attempt and clears the rows of the old one first.
 */
export interface ResultsStaging { stage(a: StageInput): Promise<StageOutcome> }

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const refused = (reason: StageRefusal, detail: readonly string[] = []): StageOutcome => ({ kind: 'refused', reason, detail });
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Version = { case_id: string; state: 'staging' | 'stored'; attempt: number; manifest_sha256: string };

/** The condition that a version row is still the staging attempt this writer began: every row batch of that attempt starts with it. */
export const attemptHolds = (db: CloudD1, rv: string, attempt: number): CloudD1Statement =>
  guard(db, "EXISTS (SELECT 1 FROM rs_results_version WHERE version_id = ? AND state = 'staging' AND attempt = ?)", rv, attempt);

/** The statements that write one version's rows. Both the one-request `stage` and the stepped stager build their rows from these. */
export const stagingRows = {
  file: (db: CloudD1, rv: string, f: { path: string; sha256: string; size: number }) =>
    db.prepare('INSERT INTO rs_package_file (version_id, path, sha256, size, object_key) VALUES (?, ?, ?, ?, ?)').bind(rv, f.path, f.sha256, f.size, packageKey(rv, f.sha256)),
  document: (db: CloudD1, rv: string, d: StagedProjection['documents'][number], listEntry: unknown) =>
    db.prepare('INSERT INTO rs_document (version_id, ref, ord, row_json, state_json, list_json, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(rv, d.ref, d.ord, d.row_json, d.state_json, JSON.stringify(listEntry), d.attachments_json),
  asset: (db: CloudD1, rv: string, x: StagedAsset) => db.prepare('INSERT INTO rs_asset (version_id, asset_key, row_json) VALUES (?, ?, ?)').bind(rv, x.key, JSON.stringify(x)),
  seed: (db: CloudD1, rv: string, x: StagedProjection['seeds'][number]) =>
    db.prepare('INSERT INTO rs_seed (version_id, ord, dataset_key, seed_id, seed_sha256, record_json) VALUES (?, ?, ?, ?, ?, ?)').bind(rv, x.ord, x.dataset_key, x.seed_id, x.seed_sha256, x.record_json),
};
/** The read-model rows of a projection, in the order they are written: documents, assets, seeds. */
export function projectionRows(db: CloudD1, rv: string, p: StagedProjection): CloudD1Statement[] {
  const list = new Map((JSON.parse(p.chronologyJson) as { ref: string }[]).map((e) => [e.ref, e]));
  return [...p.documents.map((d) => stagingRows.document(db, rv, d, list.get(d.ref))), ...p.assets.map((x) => stagingRows.asset(db, rv, x)), ...p.seeds.map((x) => stagingRows.seed(db, rv, x))];
}
/** The batch that stores a version once every count matches. */
export function sealStatements(db: CloudD1, rv: string, attempt: number, at: string): CloudD1Statement[] {
  return [
    guard(db, `EXISTS (SELECT 1 FROM rs_results_version v WHERE v.version_id = ? AND v.state = 'staging' AND v.attempt = ?
            AND v.expected_files = (SELECT COUNT(*) FROM rs_package_file WHERE version_id = v.version_id)
            AND v.expected_documents = (SELECT COUNT(*) FROM rs_document WHERE version_id = v.version_id)
            AND v.expected_assets = (SELECT COUNT(*) FROM rs_asset WHERE version_id = v.version_id)
            AND v.expected_seeds = (SELECT COUNT(*) FROM rs_seed WHERE version_id = v.version_id))`, rv, attempt),
    db.prepare("UPDATE rs_results_version SET state = 'stored', stored_at = ? WHERE version_id = ?").bind(at, rv),
  ];
}
/** An object is where its row says, with its digest. */
export async function objectMatches(bucket: { head(key: string): Promise<CloudR2Head | null> }, rv: string, f: { path: string; sha256: string; size: number }): Promise<boolean> {
  const h = await bucket.head(packageKey(rv, f.sha256)).catch(unavailable);
  const sum = h?.checksums.sha256 ? [...new Uint8Array(h.checksums.sha256)].map((n) => n.toString(16).padStart(2, '0')).join('') : null;
  return !!h && h.size === f.size && sum === f.sha256;
}

/** What `begin` needs of a validated, projected candidate: no file bytes, only their listing. */
export interface BeginInput {
  caseId: CaseId; operationId: string; identity: { resultsVersion: ResultsVersion; manifestSha256: string };
  manifest: { inputRevisionId: string; caseLabel: string | null; created: string };
  validation: StageInput['validation']; projection: StagedProjection;
  files: readonly { path: string; sha256: string; size: number }[]; total: number;
}
export type Begun = { kind: 'refused'; refusal: Extract<StageOutcome, { kind: 'refused' }> } | { kind: 'stored' } | { kind: 'begun'; attempt: number; readModelSha256: string };

/** The quota conditions of one reservation, as SQL over D1's own rows (so the check and the write are one transaction). */
const attemptsFree = 'COALESCE((SELECT SUM(attempt) FROM rs_results_version WHERE case_id = ?), 0) < ?';
const newVersionFree = `(SELECT COUNT(*) FROM rs_results_version WHERE case_id = ?) < ? AND ${attemptsFree}
    AND COALESCE((SELECT SUM(package_bytes) FROM rs_results_version WHERE case_id = ?), 0) + ? <= ? AND COALESCE((SELECT SUM(package_bytes) FROM rs_results_version), 0) + ? <= ?`;

export type Reservation = { condition: string; values: (string | number)[] };
export type Preflight = { kind: 'refused'; refusal: Extract<StageOutcome, { kind: 'refused' }> } | { kind: 'stored'; manifestSha256: string } | { kind: 'ready'; prior: Version | null; reserve: Reservation };

/**
 * The case, any existing version and both reservations, in one read: nothing is written before it. A stored version of this
 * results version is immutable and answers itself; a staging one of this case starts a new attempt; a new one needs a free version
 * slot, free package bytes (case and client) and a free attempt.
 */
export async function preflight(s: OpenWriter, a: { caseId: CaseId; resultsVersion: string; total: number }): Promise<Preflight> {
  const q = s.quotas, rv = a.resultsVersion;
  const fresh: Reservation = { condition: newVersionFree, values: [a.caseId, q.maxVersionsPerCase, a.caseId, q.maxStagingAttemptsPerCase, a.caseId, a.total, q.maxPackageBytesPerCase, a.total, q.maxPackageBytesPerClient] };
  const retry: Reservation = { condition: attemptsFree, values: [a.caseId, q.maxStagingAttemptsPerCase] };
  const pre = await s.db.prepare(`SELECT EXISTS (SELECT 1 FROM rs_case WHERE case_id = ?) AS known, p.case_id, p.state, p.attempt, p.manifest_sha256,
        (${fresh.condition}) AS fresh_ok, (${retry.condition}) AS retry_ok FROM (SELECT 1) LEFT JOIN rs_results_version p ON p.version_id = ?`)
    .bind(a.caseId, ...fresh.values, ...retry.values, rv).first<Partial<Version> & { known: number; fresh_ok: number; retry_ok: number }>().catch(unavailable);
  if (pre?.known !== 1) return { kind: 'refused', refusal: refused('unknown-case') as never };
  // Identity of an existing version: a stored one is immutable, a staging one of this case starts a new attempt.
  const prior: Version | null = pre.case_id == null ? null : { case_id: pre.case_id, state: pre.state!, attempt: pre.attempt!, manifest_sha256: pre.manifest_sha256! };
  if (prior && prior.case_id !== a.caseId) return { kind: 'refused', refusal: refused('version-of-another-case') as never };
  if (prior?.state === 'stored') return { kind: 'stored', manifestSha256: prior.manifest_sha256 };
  if ((prior ? pre.retry_ok : pre.fresh_ok) !== 1) return { kind: 'refused', refusal: refused('over-quota', ['the case or the client has no quota left for this import']) as never };
  return { kind: 'ready', prior, reserve: prior ? retry : fresh };
}

/**
 * Reserves the quota and writes the version row and the first batch of its file rows, in one batch. `wrap` puts statements around that
 * batch (a stepped run's lease guard before it, its cursor move after it) so they commit or roll back together. A batch that fails is
 * either a quota taken by a concurrent import between the check and the write, or a concurrent import of the same version that won the
 * attempt: this one stops without writing. Returns the remaining file rows' statements through `fileRows`.
 */
export async function beginVersion(s: OpenWriter, now: () => Date, a: BeginInput, pre: Extract<Preflight, { kind: 'ready' }>, wrap: { before: CloudD1Statement[]; after: CloudD1Statement[] } = { before: [], after: [] }): Promise<Begun & { first?: number }> {
  const rv = a.identity.resultsVersion, { prior, reserve } = pre, p = a.projection, v = a.validation, m = a.manifest;
  const reserved = async () => ((await s.db.prepare(`SELECT (${reserve.condition}) AS ok`).bind(...reserve.values).first<{ ok: number }>().catch(unavailable))?.ok ?? 0) === 1;
  const attempt = (prior?.attempt ?? 0) + 1, at = now().toISOString();
  const readModelSha256 = await readModelDigest(p);
  const values = [a.caseId, attempt, a.operationId, a.identity.manifestSha256, m.inputRevisionId, m.caseLabel, m.created, v.verdict, v.validatorVersion, v.diagnosticsSha256, JSON.stringify([...v.warningFingerprints].sort()),
    p.expect.documents, p.expect.assets, p.expect.seeds, p.expect.files, readModelSha256, p.overview, a.total, at] as const;
  const children = ['rs_package_file', 'rs_document', 'rs_asset', 'rs_seed', 'rs_preview'].map((t) => s.db.prepare(`DELETE FROM ${t} WHERE version_id = ?`).bind(rv));
  const head = prior
    ? [guard(s.db, `EXISTS (SELECT 1 FROM rs_results_version WHERE version_id = ? AND state = 'staging' AND attempt = ?) AND ${reserve.condition}`, rv, prior.attempt, ...(reserve.values as (string | number)[])), ...children,
      s.db.prepare('UPDATE rs_results_version SET attempt = ?, operation_id = ?, verdict = ?, validator_version = ?, diagnostics_sha256 = ?, warning_fingerprints = ?, expected_documents = ?, expected_assets = ?, expected_seeds = ?, expected_files = ?, read_model_sha256 = ?, overview = ?, staged_at = ? WHERE version_id = ?')
        .bind(attempt, a.operationId, v.verdict, v.validatorVersion, v.diagnosticsSha256, values[10], values[11], values[12], values[13], values[14], values[15], p.overview, at, rv)]
    : [guard(s.db, reserve.condition, ...(reserve.values as (string | number)[])),
      s.db.prepare(`INSERT INTO rs_results_version (version_id, case_id, state, attempt, operation_id, manifest_sha256, input_revision_id, case_label, created, verdict, validator_version, diagnostics_sha256, warning_fingerprints,
        expected_documents, expected_assets, expected_seeds, expected_files, read_model_sha256, overview, package_bytes, staged_at, import_seq) VALUES (?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(import_seq), 0) + 1 FROM rs_results_version))`).bind(rv, ...values)];
  // Package files: rows first, so every object written later is traced to a staging version. The first rows ride in the batch that writes the version row.
  const first = a.files.slice(0, s.budgets.maxRowsPerBatch).map((f) => stagingRows.file(s.db, rv, f));
  try { await s.db.batch([...wrap.before, ...head, ...first, ...wrap.after]); } catch {
    if (!(await reserved())) return { kind: 'refused', refusal: refused('over-quota', ['the case or the client has no quota left for this import']) as never };
    unavailable();
  }
  return { kind: 'begun', attempt, readModelSha256, first: first.length };
}

export interface SteppedStaging {
  /** The checks that precede any write: the case, an existing version and the quota. */
  preflight: typeof preflight;
  begin: typeof beginVersion;
}
export function createSteppedStaging(): SteppedStaging { return { preflight, begin: beginVersion }; }

export function createResultsStaging(ctx: StorageContext): ResultsStaging {
  const open = writerAccess(ctx, 'results.import');
  /** Writes `statements` in batches of at most the budget, each guarded on this version's attempt still staging. */
  async function rows(s: OpenWriter, rv: string, attempt: number, statements: CloudD1Statement[]) {
    for (let i = 0; i < statements.length; i += s.budgets.maxRowsPerBatch)
      await s.db.batch([attemptHolds(s.db, rv, attempt), ...statements.slice(i, i + s.budgets.maxRowsPerBatch)]).catch(unavailable);
  }
  return {
    async stage(a) {
      const s = await open('stage', a.caseId, a.operationId);
      const rv = a.identity.resultsVersion;
      if (!OPAQUE.test(a.operationId)) return refused('integrity', ['operationId is not an opaque id']);
      let total = 0;
      for (const bytes of a.files.values()) {
        total += bytes.byteLength;
        if (bytes.byteLength > s.budgets.maxPackageFileBytes) return refused('over-budget', ['a package file is over maxPackageFileBytes']);
      }
      if (a.files.size > s.budgets.maxPackageFiles) return refused('over-budget', ['the package has more files than maxPackageFiles']);
      if (total > s.budgets.maxPackageBytes) return refused('over-budget', ['the package is over maxPackageBytes']);

      const verdict = verifyCandidateBytes(a.files, { resultsVersion: rv, manifestSha256: a.identity.manifestSha256 });
      if (!verdict.ok) return refused('integrity', verdict.problems);
      const manifest = parseStrictJson(decodeUtf8Strict(a.files.get('manifest.json')!)) as { case: { id: string; label?: string }; inputRevision: { id: string }; created: string; files: { path: string; sha256: string; size: number }[] };
      if (manifest.case.id !== a.caseId) return refused('wrong-case', ['the package names another case']);
      // Validated once here; projected below, once the case, the version and the quota are known (so a refusal that needs no original
      // read, and an idempotent repeat of a stored version, cost no R2 read).
      const prepared = preparePackage(a.files);
      if (!prepared.ok) return refused('integrity', prepared.problems);
      // A refusal here comes before any object is written, and a retry draws on the same case-wide attempt budget.
      const pre = await preflight(s, { caseId: a.caseId, resultsVersion: rv, total });
      if (pre.kind === 'refused') return pre.refusal;
      if (pre.kind === 'stored') return pre.manifestSha256 === a.identity.manifestSha256 ? { kind: 'stored', resultsVersion: rv, repeated: true } : refused('integrity', ['a stored version with another manifest']);
      // The projection is derived from the verified bytes and the case's own verified original facts (D1 association, R2 bytes);
      // the caller's is only compared with it, and no status it carries is ever an input. A genuine fingerprint mismatch of an
      // original refuses the import here, before any write; it is never relabelled.
      const originals = await readOriginalFacts(s, a.caseId, prepared.fileAssets, a.originalLinks);
      if (originals.kind === 'refused') return refused(originals.reason, originals.problems);
      const derived = prepared.project(originals.facts);
      if (!derived.ok) return refused('integrity', derived.problems);
      const p = derived.projection;
      if (p.documents.length > s.budgets.maxDocuments) return refused('over-budget', ['the package has more documents than maxDocuments']);
      const differences = projectionDifferences(a.projection, p);
      if (differences.length) return refused('inconsistent-projection', differences.slice(0, 20));
      const listed = new Map(manifest.files.map((f) => [f.path, f]));
      const files = [...a.files.entries()].map(([path, bytes]) => ({ path, bytes, sha256: path === 'manifest.json' ? a.identity.manifestSha256 : listed.get(path)!.sha256 }));
      const begun = await beginVersion(s, ctx.now, { caseId: a.caseId, operationId: a.operationId, identity: a.identity, manifest: { inputRevisionId: manifest.inputRevision.id, caseLabel: manifest.case.label ?? null, created: manifest.created },
        validation: a.validation, projection: p, files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.bytes.byteLength })), total }, pre);
      if (begun.kind === 'refused') return begun.refusal;
      if (begun.kind === 'stored') return { kind: 'stored', resultsVersion: rv, repeated: true };
      const attempt = begun.attempt;
      await rows(s, rv, attempt, files.slice(begun.first!).map((f) => stagingRows.file(s.db, rv, { path: f.path, sha256: f.sha256, size: f.bytes.byteLength })));
      for (const f of files) {
        const w = await writeOnce(s.bucket, packageKey(rv, f.sha256), f.bytes, f.sha256);
        if (w === 'unreachable') unavailable();
        if (w === 'conflict') return refused('conflicting-object', [f.path]);
      }
      await rows(s, rv, attempt, projectionRows(s.db, rv, p));

      // Every object is where its row says, with its digest, before the version can be stored.
      for (const f of files) if (!(await objectMatches(s.bucket, rv, { path: f.path, sha256: f.sha256, size: f.bytes.byteLength }))) return refused('conflicting-object', [f.path]);
      try { await s.db.batch(sealStatements(s.db, rv, attempt, ctx.now().toISOString())); } catch { unavailable(); }
      return { kind: 'stored', resultsVersion: rv, repeated: false };
    },
  };
}
