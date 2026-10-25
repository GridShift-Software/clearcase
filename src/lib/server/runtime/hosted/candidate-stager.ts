import { canonicalText } from '../../../case-package/canonical.ts';
import { validateHostedPackage } from '../../../case-package/hosted-validation.ts';
import { foldPath } from '../../../case-package/paths.ts';
import { contentContradictsType } from '../../../case-package/media.ts';
import { verifyCandidateBytes } from '../../../case-package/verify-bytes.ts';
import { buildCoverage } from '../../../results-review/native/coverage.ts';
import { inspectPackage } from '../../../results-review/native/package.ts';
import { d1NativeCandidateRepository } from '../../../results-review/native/repository.ts';
import { submissionSnapshotReader } from '../../../results-review/native/submission-reader.ts';
import type { AuthorizeOperate, CandidateStager, StageOutcome, StageRequest, StoredPackageReader } from '../../../results-review/native/ports.ts';
import { loadVerifiedModel } from '../../../results/hosted/model.ts';
import { preparePackage, type FileAssetClaim, type OriginalFact } from '../../../results/hosted/project.ts';
import { readModelDigest, type StagedProjection } from '../../../results/hosted/read-model.ts';
import { d1SubmissionRepository } from '../../../submissions/repository.ts';
import { storageAccess, type OpenStorage } from '../../../storage/cloud/access.ts';
import type { CloudBindings, CloudD1Statement, CloudR2Head } from '../../../storage/cloud/bindings.ts';
import { storageBudgets, type StorageBudgets } from '../../../storage/cloud/budgets.ts';
import { originalKey, packageKey } from '../../../storage/cloud/keys.ts';
import { verifiedRead } from '../../../storage/cloud/objects.ts';
import { caseFolder, readOriginalFacts, type FolderOriginal } from '../../../storage/cloud/original-facts.ts';
import { storageQuotas, type StorageQuotas } from '../../../storage/cloud/quotas.ts';
import { createResultsStaging } from '../../../storage/cloud/staging.ts';
import { admitVerification, type VerificationPlan } from '../../../storage/cloud/verification.ts';
import type { AuditEvent, AuditSink, CaseId, ClientId, Identity, ResultsVersion } from '../contracts.ts';
import { contractError, isDenial } from '../errors.ts';
import type { FinalizedSubmissionSnapshot } from './alpha-contracts.ts';

/** Request-scoped, trusted deployment inputs. No defaults, request bindings, or success-stager injection. */
export interface HostedCandidateStagerOptions {
  bindings: CloudBindings;
  clientId: ClientId;
  budgets: StorageBudgets;
  quotas: StorageQuotas;
  identity: Identity;
  authorizeOperate: AuthorizeOperate;
  audit: AuditSink;
  now(): Date;
}
export interface HostedCandidateStager { stager: CandidateStager; packages: StoredPackageReader }

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const integrity = (): never => { throw contractError('integrity'); };
const refused = (reason: string, ...detail: string[]): Extract<StageOutcome, { kind: 'refused' }> => ({ kind: 'refused', reason, detail });
const same = (a: unknown, b: unknown) => canonicalText(a) === canonicalText(b);
const size = (n: number) => Number.isSafeInteger(n) && n >= 0;
type FileRow = { path: string; sha256: string; size: number; object_key: string };
type VersionRow = {
  case_id: string; state: string; manifest_sha256: string; input_revision_id: string; package_bytes: number;
  verdict: 'accept' | 'report'; validator_version: string; diagnostics_sha256: string; warning_fingerprints: string;
  read_model_sha256: string; expected_files: number; expected_documents: number; expected_assets: number; expected_seeds: number;
};
type Selection = { asset: FileAssetClaim; original: FolderOriginal };

/**
 * Real validator + private GRS-115 staging, and a separate operate-only correction reader. The parent owns composition,
 * migrations, grant policy, durable link/audit settlement and publication. This factory never grants or publishes.
 */
export function createHostedCandidateStager(o: HostedCandidateStagerOptions): HostedCandidateStager {
  // Copy policy: changing the caller's objects during an await cannot enlarge this factory's bounds.
  const budgets = storageBudgets(o.budgets), quotas = storageQuotas(o.quotas);
  if (!budgets || !quotas || !o.bindings || !o.clientId || typeof o.authorizeOperate !== 'function' || typeof o.audit?.append !== 'function') unavailable();
  const b = budgets!, q = quotas!, clientId = o.clientId, identity = o.identity;
  const bindings = { db: o.bindings.db, bucket: o.bindings.bucket };

  async function authorize(requestClient: ClientId, caseId: CaseId) {
    if (identity.kind !== 'verified') throw contractError('unauthenticated');
    if (requestClient !== clientId || identity.clientId !== clientId) throw contractError('wrong-client');
    if (identity.principal.kind !== 'staff') throw contractError('forbidden');
    await identity.checkRevocation();
    const allowed: unknown = await o.authorizeOperate({ clientId, caseId, principal: identity.principal, sessionId: identity.sessionId });
    if (allowed === false) throw contractError('forbidden');
    await identity.checkRevocation();
  }

  /** Each raw storage invocation (including synchronous construction and R2 bodies) is authority-scoped. */
  function scoped(requestClient: ClientId, caseId: CaseId) {
    const check = () => authorize(requestClient, caseId);
    async function checked<T>(f: () => Promise<T>): Promise<T> {
      await check();
      let value!: T;
      try { value = await f(); }
      catch {
        // Only raw binding invocations enter this catch: a driver's code (even a ContractError-shaped
        // object) is not contract provenance. Authority checks and application refusals stay outside it.
        await check();
        unavailable();
      }
      await check();
      return value;
    }
    // Defer prepare/bind until execution, inside the same try/await boundary as first/all/run/batch.
    // The scope-local builders still produce raw statements for one real atomic D1 batch.
    type BuildStatement = () => CloudD1Statement;
    const raw = new WeakMap<CloudD1Statement, BuildStatement>();
    function statement(build: BuildStatement): CloudD1Statement {
      const wrapped: CloudD1Statement = {
        bind: (...v) => statement(() => build().bind(...v)),
        first: <T>() => checked(() => build().first<T>()),
        all: <T>() => checked(() => build().all<T>()),
        run: () => checked(() => build().run()),
      };
      raw.set(wrapped, build);
      return wrapped;
    }
    const metadata = (head: CloudR2Head): CloudR2Head => ({
      key: head.key, size: head.size, etag: head.etag, version: head.version, checksums: { sha256: head.checksums.sha256 },
    });
    const guarded: CloudBindings = {
      db: {
        prepare: (sql) => statement(() => bindings.db.prepare(sql)),
        batch: (ss) => {
          // This is our own invariant failure, not a backend invocation; do not normalize it.
          const builds = ss.map((s) => raw.get(s) ?? integrity());
          return checked(() => bindings.db.batch(builds.map((build) => build())));
        },
      },
      bucket: {
        head: (key) => checked(async () => {
          const head = await bindings.bucket.head(key);
          return head && metadata(head);
        }),
        put: (key, bytes, options) => checked(async () => {
          const head = await bindings.bucket.put(key, bytes, options);
          return head && metadata(head);
        }),
        get: (key) => checked(async () => {
          const body = await bindings.bucket.get(key);
          return body && { ...metadata(body), arrayBuffer: () => checked(() => body.arrayBuffer()) };
        }),
      },
    };
    const open = storageAccess({ bindings: guarded, clientId, budgets: b }, 'storage-unavailable');
    return { check, checked, guarded, open };
  }

  async function audit(caseId: CaseId, rv: ResultsVersion, action: string, outcome: AuditEvent['outcome']) {
    const event: AuditEvent = {
      eventId: `native-storage-${crypto.randomUUID()}`, action, outcome, at: o.now().toISOString(), version: rv,
      actor: identity.kind === 'verified' ? { kind: 'verified', principal: identity.principal, sessionId: identity.sessionId } : { kind: 'anonymous', principal: null, sessionId: null },
      object: { kind: 'results-version', id: rv, caseId },
    };
    if ((await o.audit.append(event)).eventId !== event.eventId) integrity();
  }

  async function run<T>(a: { clientId: ClientId; caseId: CaseId; resultsVersion: ResultsVersion }, action: string, work: (s: ReturnType<typeof scoped>) => Promise<T>, outcome: (v: T) => AuditEvent['outcome'], release?: () => Promise<void>): Promise<T> {
    const s = scoped(a.clientId, a.caseId);
    try {
      await s.check();
      const value = await work(s);
      await s.check();
      await audit(a.caseId, a.resultsVersion, action, outcome(value));
      await release?.();
      await s.check();
      return value;
    } catch (e) {
      // Canonical storage helpers translate backend faults. If a guarded await lost authority, recover the current denial
      // rather than misreport it as storage-unavailable. No metadata or byte result is released on either failure.
      let failure = e;
      try { await s.check(); } catch (current) { failure = current; }
      await audit(a.caseId, a.resultsVersion, action, isDenial(failure) ? 'denied' : 'failed').catch(() => undefined);
      throw failure;
    }
  }

  async function admission(s: OpenStorage, caseId: CaseId, plan: VerificationPlan) {
    if (!size(plan.objects) || !size(plan.bytes)) return 'over-budget';
    const now = o.now().getTime();
    if (!Number.isFinite(now)) unavailable();
    return admitVerification(s, caseId, plan, now);
  }

  /** Real immutable stored package, NOT the published-only client CaseReader. No unbounded R2 access. */
  async function stored(s: OpenStorage, caseId: CaseId, rv: ResultsVersion, expectedManifest: string, prepaid?: { files: ReadonlyMap<string, Uint8Array>; projection: StagedProjection }) {
    const v = await s.db.prepare('SELECT * FROM rs_results_version WHERE version_id = ? AND case_id = ?').bind(rv, caseId).first<VersionRow>();
    if (!v || v.state !== 'stored' || v.case_id !== caseId || v.manifest_sha256 !== expectedManifest) integrity();
    const version = v!;
    if (!size(version.package_bytes) || version.package_bytes > b.maxPackageBytes || !size(version.expected_files) || version.expected_files > b.maxPackageFiles
      || !size(version.expected_documents) || version.expected_documents > b.maxDocuments || !size(version.expected_assets) || !size(version.expected_seeds)) integrity();
    const { results: rows } = await s.db.prepare('SELECT path, sha256, size, object_key FROM rs_package_file WHERE version_id = ? ORDER BY path LIMIT ?').bind(rv, b.maxPackageFiles + 1).all<FileRow>();
    const total = rows.reduce((n, f) => n + f.size, 0);
    if (rows.length !== version.expected_files || rows.length > b.maxPackageFiles || !size(total) || total !== version.package_bytes || total > b.maxPackageBytes
      || new Set(rows.map((f) => f.path)).size !== rows.length
      || rows.some((f) => !size(f.size) || f.size > b.maxPackageFileBytes || !/^[0-9a-f]{64}$/.test(f.sha256) || f.object_key !== packageKey(rv, f.sha256))) integrity();
    if (prepaid) {
      if (rows.length !== prepaid.files.size || rows.some((f) => prepaid.files.get(f.path)?.byteLength !== f.size)) integrity();
    } else {
      const admitted = await admission(s, caseId, { objects: rows.length, bytes: total });
      if (admitted !== 'admitted') throw contractError(admitted, admitted === 'busy');
    }
    const files = new Map<string, Uint8Array>();
    for (const f of rows) {
      const r = await verifiedRead(s.bucket, f.object_key, f, b.maxPackageFileBytes);
      if (r.kind === 'unreachable') unavailable();
      if (r.kind !== 'ok') integrity();
      const bytes = r.kind === 'ok' ? r.bytes : integrity();
      const expected = prepaid?.files.get(f.path);
      if (expected && (expected.length !== bytes.length || expected.some((x, i) => x !== bytes[i]))) integrity();
      files.set(f.path, bytes);
    }
    if (!verifyCandidateBytes(files, { resultsVersion: rv, manifestSha256: expectedManifest }).ok) integrity();
    const inspected = inspectPackage(files, caseId);
    if (!inspected.ok || inspected.value.inputRevisionId !== version.input_revision_id) integrity();
    await loadVerifiedModel(s.db, rv);
    if (prepaid && await readModelDigest(prepaid.projection) !== version.read_model_sha256) integrity();
    // Pin the same stored head around the awaited reads; package identity includes case/input revision, not only hashes.
    const after = await s.db.prepare('SELECT * FROM rs_results_version WHERE version_id = ? AND case_id = ?').bind(rv, caseId).first<VersionRow>();
    if (!same(version, after)) integrity();
    return { files, version };
  }

  const stager: CandidateStager = {
    stage(input) {
      const a: StageRequest = { ...input, identity: { ...input.identity }, submission: JSON.parse(canonicalText(input.submission)) as FinalizedSubmissionSnapshot };
      // Capture bounded caller bytes synchronously, before any authority/storage await. Request IDs and snapshot are pinned too.
      let total = 0;
      const files = new Map<string, Uint8Array>();
      let tooLarge = a.files.size > b.maxPackageFiles;
      if (!tooLarge) for (const [path, bytes] of a.files) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > b.maxPackageFileBytes) { tooLarge = true; break; }
        total += bytes.byteLength;
        if (!size(total) || total > b.maxPackageBytes) { tooLarge = true; break; }
        files.set(path, new Uint8Array(bytes));
      }
      a.files = files;
      let release = async () => {};
      return run({ ...a, resultsVersion: a.identity.resultsVersion }, 'results.native-stage', async (scope) => {
        if (tooLarge) return refused('over-budget', 'package exceeds file count or byte budget');
        const claimed = { ...a.identity }, supplied = canonicalText(a.submission);
        const inspected = inspectPackage(files, a.caseId);
        if (!inspected.ok) return refused(inspected.code, ...inspected.detail);
        if (inspected.value.resultsVersion !== claimed.resultsVersion || inspected.value.manifestSha256 !== claimed.manifestSha256) return refused('integrity', 'package identity differs from its bytes');
        const prepared = preparePackage(files);
        if (!prepared.ok) return refused('integrity', ...prepared.problems);
        const s = await scope.open();
        const submissions = submissionSnapshotReader(d1SubmissionRepository(s.db));
        const revisionId = a.submission.manifest.revisionId;
        async function snapshot(): Promise<FinalizedSubmissionSnapshot | null> {
          const fresh = await submissions.finalized({ clientId, caseId: a.caseId, revisionId });
          return fresh.state === 'finalized' && fresh.manifest.clientId === clientId && fresh.manifest.caseId === a.caseId
            && fresh.manifest.revisionId === revisionId && canonicalText(fresh) === supplied ? fresh : null;
        }
        const submission = await snapshot();
        if (!submission) return refused('submission-changed', 'caller snapshot is not the exact finalized submission');
        const folder = await caseFolder(s.db, clientId, a.caseId);
        if (folder.length > q.maxUploadsPerCase) return refused('over-budget', 'case folder exceeds upload quota');
        const selected = select(prepared.fileAssets, folder, submission);
        if (selected.kind === 'refused') return selected;
        if (selected.selections.some(({ original: f }) => f.size > b.maxOriginalBytes || f.size > b.maxBufferedObjectBytes)) return refused('over-budget', 'selected original exceeds byte budget');
        const unique = new Map(selected.selections.map(({ original: f }) => [f.sha256, f]));
        // Four original passes, reserved ONCE: bootstrap genuine warnings, independent readOriginalFacts, storage's own
        // derivation, then post-storage facts. Stored-byte readback is prepaid too. Repeats reserve the same upper bound.
        const plan = { objects: unique.size * 4 + files.size, bytes: [...unique.values()].reduce((n, f) => n + f.size, 0) * 4 + total };
        const admitted = await admission(s, a.caseId, plan);
        if (admitted === 'busy') throw contractError('busy', true);
        if (admitted !== 'admitted') return refused(admitted, 'verification work was not admitted');
        const facts = new Map<string, OriginalFact>(), reads = new Map<string, Uint8Array>();
        for (const { asset, original: f } of selected.selections) {
          let bytes = reads.get(f.sha256);
          if (!bytes) {
            const r = await verifiedRead(s.bucket, f.objectKey, f, b.maxBufferedObjectBytes);
            if (r.kind === 'unreachable') unavailable();
            if (r.kind !== 'ok') return refused(r.kind === 'over-budget' ? 'over-budget' : 'integrity', 'selected original is missing or changed');
            bytes = r.bytes;
            reads.set(f.sha256, bytes);
          }
          facts.set(asset.key, { path: f.path, sha256: f.sha256, size: f.size, mediaType: asset.mediaType, status: f.path === asset.path ? 'verified' : 'case-mismatch', downloadOnly: contentContradictsType(asset.mediaType, bytes.subarray(0, 1024)) });
        }
        const limits = { packageFiles: b.maxPackageFiles, fileBytes: b.maxPackageFileBytes, manifestBytes: b.maxPackageFileBytes, packageBytes: b.maxPackageBytes, originalBytes: b.maxOriginalBytes, originalsTotalBytes: b.maxVerifyBytes };
        const bootstrap = validateHostedPackage({ files, originals: facts, limits });
        if (bootstrap.result.verdict === 'reject') return refused('validator-rejected', ...bootstrap.result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code));
        if (bootstrap.result.candidate.caseId !== a.caseId) return refused('wrong-case', 'package names another case');
        const coverage = buildCoverage({ assets: bootstrap.result.candidate.assets, submission, caseMismatch: bootstrap.caseMismatch, warningFingerprints: bootstrap.result.warningFingerprints });
        if (!coverage.ok) return refused('original-link-required', ...coverage.reasons.map((r) => r.code));
        const originals = await readOriginalFacts(s, a.caseId, prepared.fileAssets, coverage.coverage.mappedOriginals);
        if (originals.kind === 'refused') return refused(originals.reason, ...originals.problems);
        if (originals.facts.size !== prepared.fileAssets.length || !same([...facts].sort(([a], [b]) => a.localeCompare(b)), [...originals.facts].sort(([a], [b]) => a.localeCompare(b)))) return refused('integrity', 'original facts changed during validation');
        const validated = validateHostedPackage({ files, originals: originals.facts, limits });
        const result = validated.result;
        if (result.verdict === 'reject') return refused('validator-rejected', ...result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code));
        if (result.diagnosticsSha256 !== bootstrap.result.diagnosticsSha256 || !same(validated.caseMismatch, bootstrap.caseMismatch)) return refused('integrity', 'validation changed during verification');
        const c = result.candidate;
        if (c.caseId !== a.caseId || c.resultsVersion !== claimed.resultsVersion || c.manifestSha256 !== claimed.manifestSha256) return refused('integrity', 'validator identity differs');
        const projected = prepared.project(originals.facts);
        if (!projected.ok) return refused('integrity', ...projected.problems);
        if (projected.projection.documents.length > b.maxDocuments) return refused('over-budget', 'too many documents');
        if (!(await snapshot())) return refused('submission-changed', 'finalized submission changed before staging');
        await scope.check();
        const validation = { verdict: result.verdict, validatorVersion: result.validatorVersion, diagnosticsSha256: result.diagnosticsSha256, warningFingerprints: result.warningFingerprints };
        const out = await createResultsStaging({ bindings: scope.guarded, clientId, budgets: b, quotas: q, authorize: async (m) => {
          if (m.clientId !== clientId || m.caseId !== a.caseId || m.capability !== 'results.import') throw contractError('forbidden');
          await scope.check();
        }, now: o.now }).stage({ caseId: a.caseId, operationId: a.operationId, files, identity: claimed, validation, projection: projected.projection, originalLinks: coverage.coverage.mappedOriginals });
        if (out.kind === 'refused') return out;
        const readback = await stored(s, a.caseId, claimed.resultsVersion, claimed.manifestSha256, { files, projection: projected.projection });
        const finalFacts = await readOriginalFacts(s, a.caseId, prepared.fileAssets, coverage.coverage.mappedOriginals);
        if (finalFacts.kind === 'refused') return refused(finalFacts.reason, ...finalFacts.problems);
        const finalValidation = validateHostedPackage({ files: readback.files, originals: finalFacts.facts, limits });
        if (finalFacts.facts.size !== prepared.fileAssets.length || finalValidation.result.verdict === 'reject'
          || finalValidation.result.diagnosticsSha256 !== result.diagnosticsSha256 || !same(finalValidation.caseMismatch, validated.caseMismatch)) return refused('validation-changed', 'originals or diagnostics changed after staging');
        const v = readback.version;
        let warnings: unknown;
        try { warnings = JSON.parse(v.warning_fingerprints); } catch { return refused('integrity', 'malformed stored warnings'); }
        if (v.input_revision_id !== c.inputRevisionId || v.verdict !== validation.verdict || v.validator_version !== validation.validatorVersion
          || v.diagnostics_sha256 !== validation.diagnosticsSha256 || !same(warnings, validation.warningFingerprints)) return refused('validation-changed', 'stored validation is not this exact validation; immutable version was not changed');
        if (!(await snapshot())) return refused('submission-changed', 'finalized submission changed after staging');
        release = async () => {
          if (!(await snapshot())) integrity();
          const head = await s.db.prepare('SELECT * FROM rs_results_version WHERE version_id = ? AND case_id = ?').bind(claimed.resultsVersion, a.caseId).first<VersionRow>();
          if (!same(head, v)) integrity();
        };
        return { kind: 'staged', repeated: out.repeated, resultsVersion: claimed.resultsVersion, manifestSha256: v.manifest_sha256, inputRevisionId: v.input_revision_id,
          verdict: v.verdict, validatorVersion: v.validator_version, diagnosticsSha256: v.diagnostics_sha256, warningFingerprints: warnings as string[], caseMismatch: validated.caseMismatch };
      }, (out) => out.kind === 'staged' ? 'succeeded' : 'refused', () => release());
    },
  };

  const packages: StoredPackageReader = {
    files(input) {
      const a = { ...input };
      let release = async () => {};
      return run(a, 'results.native-package-read', async (scope) => {
        const s = await scope.open(), repository = d1NativeCandidateRepository(s.db);
        async function current() {
          const head = await repository.byResultsVersion(a);
          if (!head) return null;
          const c = await repository.candidate({ ...a, candidateId: head.candidateId });
          if (!c?.current || c.link.clientId !== clientId || c.link.caseId !== a.caseId || c.link.candidate.resultsVersion !== a.resultsVersion
            || c.link.candidate.manifestSha256 !== head.manifestSha256) return null;
          return c;
        }
        const candidate = await current();
        if (!candidate) return null;
        const readback = await stored(s, a.caseId, a.resultsVersion, candidate.link.candidate.manifestSha256);
        if (readback.version.input_revision_id !== candidate.link.candidate.packageInputRevisionId || !same(await current(), candidate)) integrity();
        release = async () => { if (!same(await current(), candidate)) integrity(); };
        return readback.files;
      }, (out) => out ? 'succeeded' : 'refused', () => release());
    },
  };
  return { stager, packages };
}

/** PATH FIRST in the selected revision's real finalized folder; a fingerprint never chooses a path or a revision. */
function select(assets: readonly FileAssetClaim[], folder: readonly FolderOriginal[], submission: FinalizedSubmissionSnapshot): { kind: 'selected'; selections: Selection[] } | Extract<StageOutcome, { kind: 'refused' }> {
  const mine = folder.filter((f) => f.source === 'submission' && f.revisionId === submission.manifest.revisionId);
  const selections: Selection[] = [];
  for (const asset of assets) {
    const literal = mine.filter((f) => f.path === asset.path);
    const found = literal.length ? literal : mine.filter((f) => foldPath(f.path) === foldPath(asset.path));
    if (found.length !== 1) return refused('original-link-required', 'selected revision has no unique finalized original at the indexed path');
    const f = found[0];
    const declared = submission.manifest.files.filter((d) => d.assetId === f.assetId && d.path === f.path && d.sha256 === f.sha256 && d.size === f.size);
    if (declared.length !== 1 || f.sha256 !== asset.sha256 || f.size !== asset.size || f.originalSize !== f.size || !size(f.size) || f.objectKey !== originalKey(f.sha256)) return refused('integrity', 'selected path does not have the exact submission and package fingerprint');
    selections.push({ asset, original: f });
  }
  return { kind: 'selected', selections };
}
