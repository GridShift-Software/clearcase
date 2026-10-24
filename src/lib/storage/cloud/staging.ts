import type { CaseId, ResultsVersion } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { verifyCandidateBytes } from '../../case-package/verify-bytes.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../case-package/strict-json.ts';
import { projectPackage } from '../../results/hosted/project.ts';
import { projectionDifferences, readModelDigest, type StagedAsset, type StagedProjection } from '../../results/hosted/read-model.ts';
import type { CloudD1Statement } from './bindings.ts';
import type { StorageContext } from './context.ts';
import { guard } from './d1.ts';
import { packageKey } from './keys.ts';
import { writerAccess, type OpenWriter } from './mutation.ts';
import { writeOnce } from './objects.ts';

export type { StagedAsset, StagedProjection };
/**
 * One validated candidate, as the operator import controller (GRS-30) hands it over after the case-package library
 * accepted it: the exact package bytes, the identity the validator computed, its verdict, and the projection it
 * computed (`project()` of local-case/project.server.ts). The projection is a claim, not an input: storage derives the
 * canonical projection from the verified package bytes with the hosted-safe projector, refuses a claim that differs, and
 * stores and digests only what it derived. The verdict and diagnostics are the import controller's own and are recorded as given.
 */
export interface StageInput {
  caseId: CaseId;
  operationId: string;
  files: ReadonlyMap<string, Uint8Array>;
  identity: { resultsVersion: ResultsVersion; manifestSha256: string };
  validation: { verdict: 'accept' | 'report'; validatorVersion: string; diagnosticsSha256: string; warningFingerprints: readonly string[] };
  projection: StagedProjection;
}
export type StageRefusal = 'over-budget' | 'integrity' | 'wrong-case' | 'unknown-case' | 'inconsistent-projection' | 'version-of-another-case' | 'conflicting-object' | 'over-quota';
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

export function createResultsStaging(ctx: StorageContext): ResultsStaging {
  const open = writerAccess(ctx, 'results.import');
  /** Writes `statements` in batches of at most the budget, each guarded on this version's attempt still staging. */
  async function rows(s: OpenWriter, rv: string, attempt: number, statements: CloudD1Statement[]) {
    for (let i = 0; i < statements.length; i += s.budgets.maxRowsPerBatch)
      await s.db.batch([guard(s.db, "EXISTS (SELECT 1 FROM rs_results_version WHERE version_id = ? AND state = 'staging' AND attempt = ?)", rv, attempt), ...statements.slice(i, i + s.budgets.maxRowsPerBatch)]).catch(unavailable);
  }
  /** The quota conditions of one reservation, as SQL over D1's own rows (so the check and the write are one transaction). */
  const attemptsFree = 'COALESCE((SELECT SUM(attempt) FROM rs_results_version WHERE case_id = ?), 0) < ?';
  const newVersionFree = `(SELECT COUNT(*) FROM rs_results_version WHERE case_id = ?) < ? AND ${attemptsFree}
    AND COALESCE((SELECT SUM(package_bytes) FROM rs_results_version WHERE case_id = ?), 0) + ? <= ? AND COALESCE((SELECT SUM(package_bytes) FROM rs_results_version), 0) + ? <= ?`;
  return {
    async stage(a) {
      const s = await open('stage', a.caseId, a.operationId);
      const rv = a.identity.resultsVersion, q = s.quotas;
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
      // The projection is derived from the verified bytes; the caller's is only compared with it.
      const derived = projectPackage(a.files);
      if (!derived.ok) return refused('integrity', derived.problems);
      const p = derived.projection;
      if (p.documents.length > s.budgets.maxDocuments) return refused('over-budget', ['the package has more documents than maxDocuments']);
      const differences = projectionDifferences(a.projection, p);
      if (differences.length) return refused('inconsistent-projection', differences.slice(0, 20));
      const list = new Map((JSON.parse(p.chronologyJson) as { ref: string }[]).map((e) => [e.ref, e]));
      if (!(await s.db.prepare('SELECT 1 AS x FROM rs_case WHERE case_id = ?').bind(a.caseId).first().catch(unavailable))) return refused('unknown-case');

      // Identity of an existing version: a stored one is immutable, a staging one of this case starts a new attempt.
      const prior = await s.db.prepare('SELECT case_id, state, attempt, manifest_sha256 FROM rs_results_version WHERE version_id = ?').bind(rv).first<Version>().catch(unavailable);
      if (prior && prior.case_id !== a.caseId) return refused('version-of-another-case');
      if (prior?.state === 'stored') return prior.manifest_sha256 === a.identity.manifestSha256 ? { kind: 'stored', resultsVersion: rv, repeated: true } : refused('integrity', ['a stored version with another manifest']);
      // The reservation is the condition of the batch that writes the version row: a new version needs a free version slot,
      // free package bytes (case and client) and a free attempt; a retry needs a free attempt and no new bytes. A refusal
      // here comes before any object is written, and a retry draws on the same case-wide attempt budget.
      const reserve = prior
        ? { condition: attemptsFree, values: [a.caseId, q.maxStagingAttemptsPerCase] }
        : { condition: newVersionFree, values: [a.caseId, q.maxVersionsPerCase, a.caseId, q.maxStagingAttemptsPerCase, a.caseId, total, q.maxPackageBytesPerCase, total, q.maxPackageBytesPerClient] };
      const reserved = async () => ((await s.db.prepare(`SELECT (${reserve.condition}) AS ok`).bind(...reserve.values).first<{ ok: number }>().catch(unavailable))?.ok ?? 0) === 1;
      if (!(await reserved())) return refused('over-quota', ['the case or the client has no quota left for this import']);
      const attempt = (prior?.attempt ?? 0) + 1, at = ctx.now().toISOString(), v = a.validation;
      const values = [a.caseId, attempt, a.operationId, a.identity.manifestSha256, manifest.inputRevision.id, manifest.case.label ?? null, manifest.created, v.verdict, v.validatorVersion, v.diagnosticsSha256, JSON.stringify([...v.warningFingerprints].sort()),
        p.expect.documents, p.expect.assets, p.expect.seeds, p.expect.files, await readModelDigest(p), p.overview, total, at] as const;
      const children = ['rs_package_file', 'rs_document', 'rs_asset', 'rs_seed', 'rs_preview'].map((t) => s.db.prepare(`DELETE FROM ${t} WHERE version_id = ?`).bind(rv));
      const head = prior
        ? [guard(s.db, `EXISTS (SELECT 1 FROM rs_results_version WHERE version_id = ? AND state = 'staging' AND attempt = ?) AND ${reserve.condition}`, rv, prior.attempt, ...reserve.values), ...children,
          s.db.prepare('UPDATE rs_results_version SET attempt = ?, operation_id = ?, verdict = ?, validator_version = ?, diagnostics_sha256 = ?, warning_fingerprints = ?, expected_documents = ?, expected_assets = ?, expected_seeds = ?, expected_files = ?, read_model_sha256 = ?, overview = ?, staged_at = ? WHERE version_id = ?')
            .bind(attempt, a.operationId, v.verdict, v.validatorVersion, v.diagnosticsSha256, values[10], values[11], values[12], values[13], values[14], values[15], p.overview, at, rv)]
        : [guard(s.db, reserve.condition, ...reserve.values),
          s.db.prepare(`INSERT INTO rs_results_version (version_id, case_id, state, attempt, operation_id, manifest_sha256, input_revision_id, case_label, created, verdict, validator_version, diagnostics_sha256, warning_fingerprints,
            expected_documents, expected_assets, expected_seeds, expected_files, read_model_sha256, overview, package_bytes, staged_at, import_seq) VALUES (?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(import_seq), 0) + 1 FROM rs_results_version))`).bind(rv, ...values)];
      try { await s.db.batch(head); } catch {
        // Either the quota was taken by a concurrent import between the check and the batch, or a concurrent import of the same version won the attempt; this one stops without writing.
        if (!(await reserved())) return refused('over-quota', ['the case or the client has no quota left for this import']);
        unavailable();
      }

      // Package files: rows first, so every object written below is traced to a staging version, then the objects.
      const listed = new Map(manifest.files.map((f) => [f.path, f]));
      const files = [...a.files.entries()].map(([path, bytes]) => ({ path, bytes, sha256: path === 'manifest.json' ? a.identity.manifestSha256 : listed.get(path)!.sha256 }));
      await rows(s, rv, attempt, files.map((f) => s.db.prepare('INSERT INTO rs_package_file (version_id, path, sha256, size, object_key) VALUES (?, ?, ?, ?, ?)').bind(rv, f.path, f.sha256, f.bytes.byteLength, packageKey(rv, f.sha256))));
      for (const f of files) {
        const w = await writeOnce(s.bucket, packageKey(rv, f.sha256), f.bytes, f.sha256);
        if (w === 'unreachable') unavailable();
        if (w === 'conflict') return refused('conflicting-object', [f.path]);
      }
      await rows(s, rv, attempt, [
        ...p.documents.map((d) => s.db.prepare('INSERT INTO rs_document (version_id, ref, ord, row_json, state_json, list_json, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(rv, d.ref, d.ord, d.row_json, d.state_json, JSON.stringify(list.get(d.ref)), d.attachments_json)),
        ...p.assets.map((x) => s.db.prepare('INSERT INTO rs_asset (version_id, asset_key, row_json) VALUES (?, ?, ?)').bind(rv, x.key, JSON.stringify(x))),
        ...p.seeds.map((x) => s.db.prepare('INSERT INTO rs_seed (version_id, ord, dataset_key, seed_id, seed_sha256, record_json) VALUES (?, ?, ?, ?, ?, ?)').bind(rv, x.ord, x.dataset_key, x.seed_id, x.seed_sha256, x.record_json)),
      ]);

      // Every object is where its row says, with its digest, before the version can be stored.
      for (const f of files) {
        const h = await s.bucket.head(packageKey(rv, f.sha256)).catch(unavailable);
        const sum = h?.checksums.sha256 ? [...new Uint8Array(h.checksums.sha256)].map((n) => n.toString(16).padStart(2, '0')).join('') : null;
        if (!h || h.size !== f.bytes.byteLength || sum !== f.sha256) return refused('conflicting-object', [f.path]);
      }
      try {
        await s.db.batch([
          guard(s.db, `EXISTS (SELECT 1 FROM rs_results_version v WHERE v.version_id = ? AND v.state = 'staging' AND v.attempt = ?
            AND v.expected_files = (SELECT COUNT(*) FROM rs_package_file WHERE version_id = v.version_id)
            AND v.expected_documents = (SELECT COUNT(*) FROM rs_document WHERE version_id = v.version_id)
            AND v.expected_assets = (SELECT COUNT(*) FROM rs_asset WHERE version_id = v.version_id)
            AND v.expected_seeds = (SELECT COUNT(*) FROM rs_seed WHERE version_id = v.version_id))`, rv, attempt),
          s.db.prepare("UPDATE rs_results_version SET state = 'stored', stored_at = ? WHERE version_id = ?").bind(ctx.now().toISOString(), rv),
        ]);
      } catch { unavailable(); }
      return { kind: 'stored', resultsVersion: rv, repeated: false };
    },
  };
}
