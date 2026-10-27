// The stepped stager: what `createHostedCandidateStager(...).stager.stage` does for a package in one request, cut into bounded, resumable
// steps whose progress lives in the client's D1 (migration `0002_native_import_staging.sql`: native_import_stage_run and _fact). It stages
// the same version, the same rows and the same objects, and links nothing: the caller links, exactly as for the one-request import.
//
// A step claims a lease, does one bounded unit of a phase, and moves the run row in a batch that holds the lease, the epoch, the phase and
// the cursor it read, so a step that lost its lease, or ran twice, writes nothing. A killed step leaves the last commit intact and the next
// step resumes from it. No step holds the package: the non-preview files are read as bytes and each preview is carried as the facts its
// upload check recorded (size, SHA-256, PDF header). The originals are read in bounded slices and verified one by one.
import { canonicalText } from '../../../case-package/canonical.ts';
import { validateHostedPackage } from '../../../case-package/hosted-validation.ts';
import type { Limits } from '../../../case-package/limits.ts';
import { contentContradictsType } from '../../../case-package/media.ts';
import type { HeldFile } from '../../../case-package/source.ts';
import { verifyCandidateBytes } from '../../../case-package/verify-bytes.ts';
import { sha256Canonical } from '../../../results-review/native/digest.ts';
import { buildCoverage } from '../../../results-review/native/coverage.ts';
import { inspectPackage } from '../../../results-review/native/package.ts';
import { submissionSnapshotReader } from '../../../results-review/native/submission-reader.ts';
import { loadStaged, type StagedLoad } from '../../../results-review/native/staging/load.ts';
import type { StageOutcome } from '../../../results-review/native/ports.ts';
import { type StagingStatus, type StepBounds, type StepOutcome, type StepPhase, type StepRequest, type SteppedStager } from '../../../results-review/native/staging/steps.ts';
import { loadVerifiedModel } from '../../../results/hosted/model.ts';
import { preparePackage, type FileAssetClaim, type OriginalFact, type PreparedPackage } from '../../../results/hosted/project.ts';
import { readModelDigest } from '../../../results/hosted/read-model.ts';
import type { OpenStorage } from '../../../storage/cloud/access.ts';
import type { CloudBindings, CloudD1, CloudD1Statement } from '../../../storage/cloud/bindings.ts';
import type { StorageBudgets } from '../../../storage/cloud/budgets.ts';
import { guard } from '../../../storage/cloud/d1.ts';
import { packageKey } from '../../../storage/cloud/keys.ts';
import type { OpenWriter } from '../../../storage/cloud/mutation.ts';
import { verifiedRead, writeOnce } from '../../../storage/cloud/objects.ts';
import { caseFolder, readOriginalFacts, type RequiredOriginalLink } from '../../../storage/cloud/original-facts.ts';
import type { StorageQuotas } from '../../../storage/cloud/quotas.ts';
import { OPAQUE, attemptHolds, beginVersion, objectMatches, preflight, projectionRows, sealStatements, stagingRows } from '../../../storage/cloud/staging.ts';
import type { VerificationPlan } from '../../../storage/cloud/verification.ts';
import type { AuditEvent, CaseId, ClientId, ResultsVersion } from '../contracts.ts';
import { contractError, isDenial } from '../errors.ts';
import { VERSION_HEAD, integrity, originals, refused, same, select, size, unavailable, type FileRow, type VersionRow } from './stage-shared.ts';

type Refusal = Extract<StageOutcome, { kind: 'refused' }>;
type Staged = Extract<StageOutcome, { kind: 'staged' }>;
type Json = Record<string, unknown>;

/** The request-scoped authority and storage of one step, as `createHostedCandidateStager` builds it. */
export interface StepScope {
  observe(): Promise<void>;
  guarded: CloudBindings;
  open(): Promise<OpenStorage>;
  /** The version head, read only while the operator still holds the case: the call's last await. */
  release(rv: ResultsVersion): Promise<VersionRow | null>;
}
export interface SteppedToolkit {
  clientId: ClientId; budgets: StorageBudgets; quotas: StorageQuotas; limits: Partial<Limits>;
  scoped(requestClient: ClientId, caseId: CaseId, content: (key: string) => boolean): StepScope;
  audit(caseId: CaseId, rv: ResultsVersion, action: string, outcome: AuditEvent['outcome']): Promise<void>;
  admission(s: OpenStorage, caseId: CaseId, plan: VerificationPlan): Promise<'admitted' | 'over-budget' | 'busy'>;
  now(): Date;
  bounds: StepBounds;
  /** Milliseconds on a clock every builder shares. */
  clock(): number;
  /** A fresh id for each step's lease. */
  leaseId(): string;
}

// --- the run row and its facts ----------------------------------------------------------------------------------------------------------

interface Run { epoch: number; phase: StepPhase; cursorText: string; cursor: Json; meta: Json; steps: number }
type Claim = { kind: 'claimed'; run: Run } | { kind: 'done'; outcome: Staged } | { kind: 'leased' };
interface Ids { clientId: string; caseId: string; operationId: string }

const RUN_COLUMNS = 'epoch, phase, cursor, meta, steps';
const parse = (text: string): Json => JSON.parse(text) as Json;
const runOf = (r: { epoch: number; phase: string; cursor: string; meta: string; steps: number }): Run => ({ epoch: r.epoch, phase: r.phase as StepPhase, cursorText: r.cursor, cursor: parse(r.cursor), meta: parse(r.meta), steps: r.steps });

async function claimRun(db: CloudD1, id: Ids, lease: string, nowMs: number, untilMs: number, nowIso: string): Promise<Claim> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const taken = await db.prepare(`UPDATE native_import_stage_run SET lease_id = ?, lease_until_ms = ? WHERE client_id = ? AND case_id = ? AND operation_id = ? AND phase <> 'done' AND lease_until_ms <= ? RETURNING ${RUN_COLUMNS}`)
      .bind(lease, untilMs, id.clientId, id.caseId, id.operationId, nowMs).all<{ epoch: number; phase: string; cursor: string; meta: string; steps: number }>();
    if (taken.results.length === 1) return { kind: 'claimed', run: runOf(taken.results[0]!) };
    const now = await db.prepare('SELECT phase, outcome FROM native_import_stage_run WHERE client_id = ? AND case_id = ? AND operation_id = ?').bind(id.clientId, id.caseId, id.operationId).first<{ phase: string; outcome: string | null }>();
    if (!now) {
      // The first step of an operation: the run starts at its plan. An operation that already has a run inserts nothing.
      await db.prepare(`INSERT INTO native_import_stage_run (client_id, case_id, operation_id, epoch, phase, cursor, meta, steps, lease_id, lease_until_ms, updated_at)
        SELECT ?, ?, ?, 0, 'plan', '{}', '{}', 0, NULL, 0, ? WHERE NOT EXISTS (SELECT 1 FROM native_import_stage_run WHERE client_id = ? AND case_id = ? AND operation_id = ?)`)
        .bind(id.clientId, id.caseId, id.operationId, nowIso, id.clientId, id.caseId, id.operationId).run();
      continue;
    }
    if (now.phase === 'done') return { kind: 'done', outcome: JSON.parse(now.outcome!) as Staged };
    return { kind: 'leased' };
  }
  return { kind: 'leased' };
}

const factKey = (id: Ids, epoch: number, pass: string, key: string) => [id.clientId, id.caseId, id.operationId, epoch, pass, key] as const;
/** Write-once, and safe to repeat: a row that already exists is left alone. */
const putFact = (db: CloudD1, id: Ids, epoch: number, pass: string, key: string, value: unknown): CloudD1Statement =>
  db.prepare(`INSERT INTO native_import_stage_fact (client_id, case_id, operation_id, epoch, pass, key, value)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM native_import_stage_fact WHERE client_id = ? AND case_id = ? AND operation_id = ? AND epoch = ? AND pass = ? AND key = ?)`)
    .bind(...factKey(id, epoch, pass, key), JSON.stringify(value), ...factKey(id, epoch, pass, key));
async function factPage(db: CloudD1, id: Ids, epoch: number, pass: string, after: string, limit: number) {
  const { results } = await db.prepare('SELECT key, value FROM native_import_stage_fact WHERE client_id = ? AND case_id = ? AND operation_id = ? AND epoch = ? AND pass = ? AND key > ? ORDER BY key LIMIT ?')
    .bind(id.clientId, id.caseId, id.operationId, epoch, pass, after, limit).all<{ key: string; value: string }>();
  return results.map((r) => ({ key: r.key, value: parse(r.value) }));
}
async function factsAt(db: CloudD1, id: Ids, epoch: number, pass: string, keys: readonly string[]) {
  if (keys.length === 0) return [];
  const { results } = await db.prepare(`SELECT key, value FROM native_import_stage_fact WHERE client_id = ? AND case_id = ? AND operation_id = ? AND epoch = ? AND pass = ? AND key IN (${keys.map(() => '?').join(', ')}) ORDER BY key`)
    .bind(id.clientId, id.caseId, id.operationId, epoch, pass, ...keys).all<{ key: string; value: string }>();
  return results.map((r) => ({ key: r.key, value: parse(r.value) }));
}
async function factCount(db: CloudD1, id: Ids, epoch: number, pass: string): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM native_import_stage_fact WHERE client_id = ? AND case_id = ? AND operation_id = ? AND epoch = ? AND pass = ?').bind(id.clientId, id.caseId, id.operationId, epoch, pass).first<{ n: number }>();
  return r?.n ?? 0;
}
async function allFacts(db: CloudD1, id: Ids, epoch: number, pass: string, page = 500) {
  const out: { key: string; value: Json }[] = [];
  for (let after = ''; ;) {
    const rows = await factPage(db, id, epoch, pass, after, page);
    out.push(...rows);
    if (rows.length < page) return out;
    after = rows[rows.length - 1]!.key;
  }
}

// --- the stepper ------------------------------------------------------------------------------------------------------------------------

interface Next { phase: StepPhase; cursor?: Json; meta?: Json; outcome?: Staged | Refusal | null; restart?: boolean }
type Out = { kind: 'advance'; done: number; total: number } | { kind: 'refused'; refusal: Refusal } | { kind: 'done'; outcome: Staged };
const advance = (done: number, total: number): Out => ({ kind: 'advance', done, total });
const refuse = (reason: string, ...detail: string[]): Out => ({ kind: 'refused', refusal: refused(reason, ...detail) });

interface Ctx {
  req: StepRequest; rv: ResultsVersion; id: Ids; lease: string; scope: StepScope; s: OpenStorage; w: OpenWriter; run: Run; started: number;
  commit(next: Next, statements?: CloudD1Statement[], o?: { idempotent?: boolean }): Promise<void>;
  wrap(next: Next): { before: CloudD1Statement[]; after: CloudD1Statement[]; applied(): void };
}

/** Marks a step whose lease or position was taken by another: it wrote nothing, and its caller is told to try again. */
class LostLease extends Error {}

export function createSteppedStager(t: SteppedToolkit): SteppedStager {
  const b = t.budgets, q = t.quotas;
  // A step's verification work is admitted against the case's window as one call, so it may not exceed what one call may plan.
  const bounds: StepBounds = { ...t.bounds, objectsPerStep: Math.min(t.bounds.objectsPerStep, b.maxVerifyObjects), bytesPerStep: Math.min(t.bounds.bytesPerStep, b.maxVerifyBytes) };
  const pageRows = Math.max(1, b.maxRowsPerBatch);
  // A fact row rides with its step's commit, which is one batch: a slice never carries more originals than a batch carries rows.
  const originalsPerStep = Math.max(1, Math.min(bounds.originalsPerStep, pageRows - 4, b.maxVerifyObjects));
  const READ_CONCURRENCY = 6;

  async function pool<T, R>(items: readonly T[], f: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!); }));
    return out;
  }

  async function step(req: StepRequest): Promise<StepOutcome> {
    const rv = req.identity.resultsVersion as ResultsVersion;
    const id: Ids = { clientId: req.clientId, caseId: req.caseId, operationId: req.operationId };
    const scope = t.scoped(req.clientId, req.caseId, originals);
    const lease = t.leaseId();
    let ctx: Ctx | null = null;
    try {
      await scope.observe();
      const s = await scope.open();
      const nowMs = t.clock();
      const claim = await claimRun(s.db, id, lease, nowMs, nowMs + bounds.leaseMs, t.now().toISOString());
      if (claim.kind === 'leased') return { kind: 'busy' };
      if (claim.kind === 'done') return claim.outcome;
      const c: Ctx = ctx = {
        req, rv, id, lease, scope, s, w: { ...s, quotas: q }, run: claim.run, started: nowMs,
        wrap(next) {
          const run = c.run, at = t.clock();
          const cursor = next.restart ? {} : (next.cursor ?? run.cursor), meta = next.restart ? {} : (next.meta ?? run.meta);
          const epoch = run.epoch + (next.restart ? 1 : 0);
          const update = s.db.prepare(`UPDATE native_import_stage_run SET epoch = ?, phase = ?, cursor = ?, meta = ?, outcome = ?, steps = steps + 1, lease_until_ms = ?, updated_at = ? WHERE client_id = ? AND case_id = ? AND operation_id = ?`)
            .bind(epoch, next.phase, JSON.stringify(cursor), JSON.stringify(meta), next.outcome ? JSON.stringify(next.outcome) : null, at + bounds.leaseMs, t.now().toISOString(), id.clientId, id.caseId, id.operationId);
          return {
            before: [guard(s.db, 'EXISTS (SELECT 1 FROM native_import_stage_run WHERE client_id = ? AND case_id = ? AND operation_id = ? AND lease_id = ? AND epoch = ? AND phase = ? AND cursor = ? AND lease_until_ms > ?)',
              id.clientId, id.caseId, id.operationId, lease, run.epoch, run.phase, run.cursorText, at)],
            after: [update],
            applied() { c.run = { epoch, phase: next.phase, cursorText: JSON.stringify(cursor), cursor, meta, steps: run.steps + 1 }; },
          };
        },
        async commit(next, statements = [], o = {}) {
          const { before, after, applied } = c.wrap(next);
          const cap = pageRows;
          if (statements.length > cap + 1) {
            // Too many rows for one batch: only statements that are safe to repeat may be split, each chunk behind the same lease guard.
            if (!o.idempotent) integrity();
            for (let i = 0; i < statements.length; i += cap) await s.db.batch([...before, ...statements.slice(i, i + cap)]);
            await s.db.batch([...before, ...after]);
          } else await s.db.batch([...before, ...statements, ...after]);
          applied();
        },
      };
      const out = await HANDLERS[c.run.phase]!(c);
      if (out.kind === 'refused') {
        await c.commit({ phase: 'plan', restart: true, outcome: out.refusal });
        await t.audit(req.caseId, rv, 'results.native-stage', 'refused');
        await scope.observe();
        await release(c);
        return out.refusal;
      }
      if (out.kind === 'done') { await release(c); return out.outcome; }
      await release(c);
      return { kind: 'staging', phase: c.run.phase, steps: c.run.steps, done: out.done, total: out.total } satisfies StagingStatus;
    } catch (e) {
      // A step whose lease or position went to another wrote nothing: tell the caller to come back, not that storage failed.
      if (e instanceof LostLease || ctx && await lostLease(ctx, lease).catch(() => false)) return { kind: 'busy' };
      // Canonical storage helpers translate backend faults. If a guarded await lost authority, recover the current denial rather than
      // misreport it as storage-unavailable; a denial and a permanent fault are audited, a retryable one is not (the step is simply repeated).
      let failure = e;
      try { await scope.observe(); } catch (current) { failure = current; }
      if (isDenial(failure) || (failure as { retryable?: boolean })?.retryable === false) await t.audit(req.caseId, rv, 'results.native-stage', isDenial(failure) ? 'denied' : 'failed').catch(() => undefined);
      throw failure;
    }
  }

  /** The step's lease is over: the run row is no longer the one it claimed. */
  async function lostLease(c: Ctx, lease: string): Promise<boolean> {
    const r = await c.s.db.prepare('SELECT lease_id, epoch, phase, cursor FROM native_import_stage_run WHERE client_id = ? AND case_id = ? AND operation_id = ?')
      .bind(c.id.clientId, c.id.caseId, c.id.operationId).first<{ lease_id: string | null; epoch: number; phase: string; cursor: string }>();
    return !!r && (r.lease_id !== lease || r.epoch !== c.run.epoch || r.phase !== c.run.phase || r.cursor !== c.run.cursorText);
  }
  async function release(c: Ctx) {
    await c.s.db.prepare('UPDATE native_import_stage_run SET lease_id = NULL, lease_until_ms = 0 WHERE client_id = ? AND case_id = ? AND operation_id = ? AND lease_id = ?')
      .bind(c.id.clientId, c.id.caseId, c.id.operationId, c.lease).run().catch(() => undefined);
  }

  // --- what every phase reads --------------------------------------------------------------------------------------------------------------

  const expectOk = (loaded: StagedLoad): Out | null => (loaded.ok ? null
    : refuse(loaded.code === 'too-large' ? 'over-budget' : 'integrity', ...loaded.detail));
  const listing = (c: Ctx) => [{ path: 'manifest.json', sha256: c.req.identity.manifestSha256, size: c.req.pkg.manifest.byteLength }, ...[...c.req.pkg.files].map(([path, f]) => ({ path, sha256: f.sha256, size: f.size }))]
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const totalBytes = (c: Ctx) => listing(c).reduce((n, f) => n + f.size, 0);
  const asFact = (v: Json) => v as unknown as OriginalFact;
  const factMap = (rows: { key: string; value: Json }[]) => new Map(rows.map((r) => [r.key, asFact(r.value)]));
  const sortedFacts = (m: ReadonlyMap<string, OriginalFact>) => [...m].sort(([x], [y]) => x.localeCompare(y));

  async function structure(c: Ctx) {
    const loaded = await loadStaged(c.req.pkg, bounds.structuredBytes);
    if (!loaded.ok) return { ok: false as const, out: expectOk(loaded)! };
    const prepared = preparePackage(loaded.value.files, loaded.value.held);
    return { ok: true as const, files: loaded.value.files, held: loaded.value.held as ReadonlyMap<string, HeldFile>, prepared };
  }
  const preparedOrRefuse = (p: PreparedPackage): Out | null => (p.ok ? null : refuse('integrity', ...p.problems));

  // --- the phases ---------------------------------------------------------------------------------------------------------------------------

  /** plan: the checks that need no original, then the originals the package names, written as facts. */
  async function plan(c: Ctx): Promise<Out> {
    const { req } = c, files = req.pkg.files;
    if (files.size + 1 > b.maxPackageFiles || [...files.values()].some((f) => f.size > b.maxPackageFileBytes) || totalBytes(c) > b.maxPackageBytes) return refuse('over-budget', 'package exceeds file count or byte budget');
    if (!OPAQUE.test(req.operationId)) return refuse('integrity', 'operationId is not an opaque id');
    const loaded = await structure(c);
    if (!loaded.ok) return loaded.out;
    const inspected = inspectPackage(loaded.files, req.caseId, loaded.held);
    if (!inspected.ok) return refuse(inspected.code, ...inspected.detail);
    if (inspected.value.resultsVersion !== req.identity.resultsVersion || inspected.value.manifestSha256 !== req.identity.manifestSha256) return refuse('integrity', 'package identity differs from its bytes');
    const bad = preparedOrRefuse(loaded.prepared);
    if (bad) return bad;
    const prepared = loaded.prepared as Extract<PreparedPackage, { ok: true }>;
    const s = c.s;
    // A finalized submission's revision, file and upload rows are immutable, so the caller's snapshot is checked against them once.
    const fresh = await submissionSnapshotReader(s.db).finalized({ clientId: t.clientId, caseId: req.caseId, revisionId: req.submission.manifest.revisionId });
    if (fresh.state !== 'finalized' || canonicalText(fresh) !== canonicalText(req.submission)) return refuse('submission-changed', 'caller snapshot is not the exact finalized submission');
    const folder = await caseFolder(s.db, t.clientId, req.caseId);
    if (folder.length > q.maxUploadsPerCase) return refuse('over-budget', 'case folder exceeds upload quota');
    const selected = select(prepared.fileAssets, folder, fresh);
    if (selected.kind === 'refused') return { kind: 'refused', refusal: selected };
    if (selected.selections.some(({ original: f }) => f.size > b.maxOriginalBytes || f.size > b.maxBufferedObjectBytes)) return refuse('over-budget', 'selected original exceeds byte budget');
    // The checks that precede any write: the case, an existing version, the quota.
    const pre = await preflight(c.w, { caseId: req.caseId, resultsVersion: req.identity.resultsVersion, total: totalBytes(c) });
    if (pre.kind === 'refused') return { kind: 'refused', refusal: pre.refusal };
    if (pre.kind === 'stored' && pre.manifestSha256 !== req.identity.manifestSha256) return refuse('integrity', 'a stored version with another manifest');
    const statements = selected.selections.map(({ asset, original: f }) => putFact(s.db, c.id, c.run.epoch, 'plan', asset.key,
      { path: f.path, sha256: f.sha256, size: f.size, objectKey: f.objectKey, assetPath: asset.path, mediaType: asset.mediaType }));
    const expected = statements.length;
    // Idempotent rows in chunks, then the move to the next phase, which holds only if every row is there.
    await c.commit({ phase: 'originals-a', cursor: { after: '', n: 0 }, meta: { assets: expected } }, [
      ...statements,
      guard(s.db, '(SELECT COUNT(*) FROM native_import_stage_fact WHERE client_id = ? AND case_id = ? AND operation_id = ? AND epoch = ? AND pass = ?) = ?', c.id.clientId, c.id.caseId, c.id.operationId, c.run.epoch, 'plan', expected),
    ], { idempotent: true });
    return advance(0, expected);
  }

  /** The slice of the plan one pass reads next: bounded by count, by bytes and by wall time, and never empty while any is left. */
  async function slice(c: Ctx) {
    const after = String(c.run.cursor.after ?? ''), assets = Number(c.run.meta.assets ?? 0);
    const rows = await factPage(c.s.db, c.id, c.run.epoch, 'plan', after, originalsPerStep + 1);
    const taken: typeof rows = [];
    let bytes = 0;
    for (const r of rows.slice(0, originalsPerStep)) {
      const sz = Number(r.value.size);
      if (taken.length > 0 && bytes + sz > bounds.bytesPerStep) break;
      taken.push(r);
      bytes += sz;
    }
    return { taken, bytes, more: rows.length > taken.length, assets, n: Number(c.run.cursor.n ?? 0) };
  }
  const claimOf = (r: { key: string; value: Json }): FileAssetClaim => ({ key: r.key, path: String(r.value.assetPath), sha256: String(r.value.sha256), size: Number(r.value.size), mediaType: String(r.value.mediaType) });
  async function admit(c: Ctx, objects: number, bytes: number): Promise<Out | null> {
    const admitted = await t.admission(c.s, c.req.caseId, { objects, bytes });
    if (admitted === 'busy') throw contractError('busy', true);
    return admitted === 'admitted' ? null : refuse(admitted, 'verification work was not admitted');
  }

  /** originals-a: each selected original, read once and verified, becomes a fact by the stager's own derivation. */
  async function originalsA(c: Ctx): Promise<Out> {
    const sl = await slice(c), s = c.s;
    if (sl.taken.length === 0) { await c.commit({ phase: 'validate-a', cursor: {} }); return advance(0, sl.assets); }
    const denied = await admit(c, new Set(sl.taken.map((r) => String(r.value.sha256))).size, sl.bytes);
    if (denied) return denied;
    const reads = new Map<string, Promise<Awaited<ReturnType<typeof verifiedRead>>>>();
    const read = (r: { value: Json }) => {
      const sha = String(r.value.sha256);
      if (!reads.has(sha)) reads.set(sha, verifiedRead(s.bucket, String(r.value.objectKey), { size: Number(r.value.size), sha256: sha }, b.maxBufferedObjectBytes));
      return reads.get(sha)!;
    };
    const done: [string, Json][] = [];
    // A group of reads at a time, so the step can stop at its wall time with every original it reached recorded.
    for (let i = 0; i < sl.taken.length && (i === 0 || t.clock() - c.started < bounds.wallMsPerStep); i += READ_CONCURRENCY) {
      const group = sl.taken.slice(i, i + READ_CONCURRENCY);
      const facts = await pool(group, async (r) => {
        const got = await read(r);
        if (got.kind === 'unreachable') unavailable();
        if (got.kind !== 'ok') return refuse(got.kind === 'over-budget' ? 'over-budget' : 'integrity', 'selected original is missing or changed');
        const claim = claimOf(r);
        return [r.key, { path: String(r.value.path), sha256: String(r.value.sha256), size: Number(r.value.size), mediaType: claim.mediaType, status: String(r.value.path) === claim.path ? 'verified' : 'case-mismatch',
          downloadOnly: contentContradictsType(claim.mediaType, got.bytes.subarray(0, 1024)) }] as const;
      });
      const bad = facts.find((f): f is Out => !Array.isArray(f));
      if (bad) return bad;
      done.push(...(facts as readonly (readonly [string, Json])[]).map(([k, v]) => [k, v] as [string, Json]));
    }
    const more = sl.more || done.length < sl.taken.length;
    const last = done[done.length - 1]![0];
    const n = sl.n + done.length;
    await c.commit(more ? { phase: 'originals-a', cursor: { after: last, n } } : { phase: 'validate-a', cursor: {} }, done.map(([k, v]) => putFact(s.db, c.id, c.run.epoch, 'a', k, v)));
    return advance(n, sl.assets);
  }

  /** validate-a: the bootstrap validation over the first facts, and the coverage that says which stored original answers which package file. */
  async function validateA(c: Ctx): Promise<Out> {
    const loaded = await structure(c);
    if (!loaded.ok) return loaded.out;
    const facts = factMap(await allFacts(c.s.db, c.id, c.run.epoch, 'a'));
    const bootstrap = validateHostedPackage({ files: loaded.files, held: loaded.held, originals: facts, limits: t.limits });
    if (bootstrap.result.verdict === 'reject') return refuse('validator-rejected', ...bootstrap.result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code));
    if (bootstrap.result.candidate.caseId !== c.req.caseId) return refuse('wrong-case', 'package names another case');
    const coverage = buildCoverage({ assets: bootstrap.result.candidate.assets, submission: c.req.submission, caseMismatch: bootstrap.caseMismatch, warningFingerprints: bootstrap.result.warningFingerprints });
    if (!coverage.ok) return refuse('original-link-required', ...coverage.reasons.map((r) => r.code));
    const links = coverage.coverage.mappedOriginals;
    const statements = links.flatMap((link) => link.packageRefs.map((ref) => putFact(c.s.db, c.id, c.run.epoch, 'links', ref, link)));
    const expected = links.reduce((n, l) => n + l.packageRefs.length, 0);
    await c.commit({ phase: 'originals-b', cursor: { after: '', n: 0 }, meta: { ...c.run.meta, links: expected, bootstrap: { digest: bootstrap.result.diagnosticsSha256, caseMismatch: await sha256Canonical(bootstrap.caseMismatch) } } }, [
      ...statements,
      guard(c.s.db, '(SELECT COUNT(*) FROM native_import_stage_fact WHERE client_id = ? AND case_id = ? AND operation_id = ? AND epoch = ? AND pass = ?) = ?', c.id.clientId, c.id.caseId, c.id.operationId, c.run.epoch, 'links', expected),
    ], { idempotent: true });
    return advance(0, Number(c.run.meta.assets ?? 0));
  }

  /** originals-b and originals-d: the storage rule's derivation, with the coverage's links, in bounded slices. A pass's refusals are kept and merged at its end. */
  const independent = (pass: 'b' | 'd', after: StepPhase, again: StepPhase) => async (c: Ctx): Promise<Out> => {
    const sl = await slice(c), s = c.s;
    if (sl.taken.length === 0) { await c.commit({ phase: after, cursor: {} }); return advance(0, sl.assets); }
    const denied = await admit(c, new Set(sl.taken.map((r) => String(r.value.sha256))).size, sl.bytes);
    if (denied) return denied;
    const statements: CloudD1Statement[] = [];
    const refusals: { reason: string; problems: string[] }[] = [];
    let handled = 0;
    // A group of originals at a time, so the step can stop at its wall time with every original it reached recorded.
    for (let i = 0; i < sl.taken.length && (i === 0 || t.clock() - c.started < bounds.wallMsPerStep); i += READ_CONCURRENCY) {
      const group = sl.taken.slice(i, i + READ_CONCURRENCY), keys = new Set(group.map((r) => r.key));
      // The links of this group: every link that names one of its keys, narrowed to those keys.
      const linkRows = await factsAt(s.db, c.id, c.run.epoch, 'links', [...keys]);
      const byLink = new Map<string, RequiredOriginalLink>();
      for (const r of linkRows) {
        const link = r.value as unknown as RequiredOriginalLink;
        byLink.set(canonicalText(link), { ...link, packageRefs: link.packageRefs.filter((ref) => keys.has(ref)) as RequiredOriginalLink['packageRefs'] });
      }
      const got = await readOriginalFacts(s, c.req.caseId, group.map(claimOf), [...byLink.values()]);
      if (got.kind === 'ok') statements.push(...[...got.facts].map(([k, v]) => putFact(s.db, c.id, c.run.epoch, pass, k, v)));
      else refusals.push({ reason: got.reason, problems: got.problems });
      handled += group.length;
    }
    const last = sl.taken[handled - 1]!.key;
    const n = sl.n + handled;
    const more = sl.more || handled < sl.taken.length;
    // A pass's refusals are kept as facts and merged at its end, so a refusal anywhere refuses the pass with the reason and the first
    // problems `readOriginalFacts` would have given for the whole.
    if (refusals.length > 0) statements.push(...refusals.map((r, k) => putFact(s.db, c.id, c.run.epoch, `refused-${pass}`, `${String(sl.n).padStart(9, '0')}-${k}`, r)));
    if (more) { await c.commit({ phase: again, cursor: { after: last, n } }, statements); return advance(n, sl.assets); }
    const kept = [...(await allFacts(s.db, c.id, c.run.epoch, `refused-${pass}`)).map((r) => r.value as unknown as { reason: string; problems: string[] }), ...refusals];
    const unique = [...new Map(kept.map((r) => [canonicalText(r), r] as const)).values()];
    if (unique.length > 0) {
      const reasons = unique.map((r) => r.reason);
      const reason = reasons.includes('integrity') ? 'integrity' : reasons.includes('original-link-required') ? 'original-link-required' : 'over-budget';
      const seen = new Set<string>();
      const problems = unique.flatMap((r) => r.problems).filter((p) => !seen.has(p) && seen.add(p)).slice(0, 20);
      return refuse(reason, ...problems);
    }
    await c.commit({ phase: after, cursor: {} }, statements);
    return advance(n, sl.assets);
  };

  /** begin: the two derivations must agree, the package validates with them, and the version row is written. */
  async function begin(c: Ctx): Promise<Out> {
    const loaded = await structure(c);
    if (!loaded.ok) return loaded.out;
    const bad = preparedOrRefuse(loaded.prepared);
    if (bad) return bad;
    const prepared = loaded.prepared as Extract<PreparedPackage, { ok: true }>;
    const { req, s } = c, id = c.id;
    const a = factMap(await allFacts(s.db, id, c.run.epoch, 'a')), bb = factMap(await allFacts(s.db, id, c.run.epoch, 'b'));
    if (bb.size !== prepared.fileAssets.length || !same(sortedFacts(a), sortedFacts(bb))) return refuse('integrity', 'original facts changed during validation');
    const validated = validateHostedPackage({ files: loaded.files, held: loaded.held, originals: bb, limits: t.limits });
    const result = validated.result;
    if (result.verdict === 'reject') return refuse('validator-rejected', ...result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code));
    const boot = c.run.meta.bootstrap as { digest: string; caseMismatch: string };
    if (result.diagnosticsSha256 !== boot.digest || await sha256Canonical(validated.caseMismatch) !== boot.caseMismatch) return refuse('integrity', 'validation changed during verification');
    const cand = result.candidate;
    if (cand.caseId !== req.caseId || cand.resultsVersion !== req.identity.resultsVersion || cand.manifestSha256 !== req.identity.manifestSha256) return refuse('integrity', 'validator identity differs');
    const projected = prepared.project(bb);
    if (!projected.ok) return refuse('integrity', ...projected.problems);
    if (projected.projection.documents.length > b.maxDocuments) return refuse('over-budget', 'too many documents');
    const files = listing(c);
    const total = totalBytes(c);
    const pre = await preflight(c.w, { caseId: req.caseId, resultsVersion: req.identity.resultsVersion, total });
    if (pre.kind === 'refused') return { kind: 'refused', refusal: pre.refusal };
    if (pre.kind === 'stored') {
      if (pre.manifestSha256 !== req.identity.manifestSha256) return refuse('integrity', 'a stored version with another manifest');
      // Stored by an earlier operation: nothing to write, and the stored version is read back below as for any other.
      await c.commit({ phase: 'readback', cursor: { i: 0 }, meta: { ...c.run.meta, repeated: true } });
      return advance(0, files.length);
    }
    const manifest = JSON.parse(new TextDecoder().decode(req.pkg.manifest)) as { case: { label?: string }; inputRevision: { id: string }; created: string };
    const validation = { verdict: result.verdict, validatorVersion: result.validatorVersion, diagnosticsSha256: result.diagnosticsSha256, warningFingerprints: result.warningFingerprints };
    const input = { caseId: req.caseId, operationId: req.operationId, identity: { resultsVersion: c.rv, manifestSha256: req.identity.manifestSha256 }, manifest: { inputRevisionId: manifest.inputRevision.id, caseLabel: manifest.case.label ?? null, created: manifest.created },
      validation, projection: projected.projection, files, total };
    // The version row, the quota and the first file rows commit together with the run's move to `rows`: one batch behind the lease.
    const first = Math.min(files.length, b.maxRowsPerBatch);
    const attempt = (pre.prior?.attempt ?? 0) + 1, readModelSha256 = await readModelDigest(projected.projection);
    const next: Next = { phase: 'rows', cursor: { i: first }, meta: { ...c.run.meta, repeated: false, attempt, readModelSha256 } };
    const wrapped = c.wrap(next);
    const begun = await beginVersion(c.w, t.now, input, pre, { before: wrapped.before, after: wrapped.after });
    if (begun.kind === 'refused') return { kind: 'refused', refusal: begun.refusal };
    if (begun.kind === 'stored' || begun.attempt !== attempt || begun.readModelSha256 !== readModelSha256) return refuse('integrity', 'the version changed while it began');
    wrapped.applied();
    return advance(0, files.length);
  }

  /** rows: the rest of the file rows, then the read-model rows, a batch at a time, each moving the cursor. */
  async function rows(c: Ctx): Promise<Out> {
    const loaded = await structure(c);
    if (!loaded.ok) return loaded.out;
    const bad = preparedOrRefuse(loaded.prepared);
    if (bad) return bad;
    const prepared = loaded.prepared as Extract<PreparedPackage, { ok: true }>;
    const { s } = c, rv = c.rv, attempt = Number(c.run.meta.attempt);
    const bb = factMap(await allFacts(s.db, c.id, c.run.epoch, 'b'));
    const projected = prepared.project(bb);
    if (!projected.ok) return refuse('integrity', ...projected.problems);
    if (await readModelDigest(projected.projection) !== c.run.meta.readModelSha256) return refuse('integrity', 'the read model changed between steps');
    const files = listing(c);
    const all = [...files.map((f) => ({ file: f })), ...projectionRows(s.db, rv, projected.projection).map((st) => ({ st }))];
    let i = Number(c.run.cursor.i ?? 0), written = 0;
    while (i < all.length && (written === 0 || written < bounds.rowsPerStep)) {
      const chunk = all.slice(i, i + b.maxRowsPerBatch);
      const done = i + chunk.length >= all.length;
      await c.commit(done ? { phase: 'objects', cursor: { i: 0 } } : { phase: 'rows', cursor: { i: i + chunk.length } },
        [attemptHolds(s.db, rv, attempt), ...chunk.map((x) => ('file' in x ? stagingRows.file(s.db, rv, x.file!) : x.st!))]);
      i += chunk.length;
      written += chunk.length;
      if (done) break;
    }
    return advance(i, all.length);
  }

  /** objects: each package file, copied from the staged store to its content key; an object another import already wrote is left alone. */
  async function objects(c: Ctx): Promise<Out> {
    const files = listing(c);
    let i = Number(c.run.cursor.i ?? 0), n = 0, bytes = 0;
    while (i < files.length && n < bounds.objectsPerStep && (n === 0 || (bytes < bounds.bytesPerStep && t.clock() - c.started < bounds.wallMsPerStep))) {
      const f = files[i]!;
      const data = f.path === 'manifest.json' ? c.req.pkg.manifest : await c.req.pkg.read(f.path);
      const w = await writeOnce(c.s.bucket, packageKey(c.rv, f.sha256), data, f.sha256);
      if (w === 'unreachable') unavailable();
      if (w === 'conflict') return refuse('conflicting-object', f.path);
      bytes += f.size; n++; i++;
    }
    await c.commit(i >= files.length ? { phase: 'verify', cursor: { i: 0 } } : { phase: 'objects', cursor: { i } });
    return advance(i, files.length);
  }

  /** verify: every object is where its row says, with its digest, and then the version is stored. */
  async function verify(c: Ctx): Promise<Out> {
    const files = listing(c);
    let i = Number(c.run.cursor.i ?? 0), n = 0;
    const attempt = Number(c.run.meta.attempt);
    while (i < files.length && n < bounds.objectsPerStep && (n === 0 || t.clock() - c.started < bounds.wallMsPerStep)) {
      if (!(await objectMatches(c.s.bucket, c.rv, files[i]!))) return refuse('conflicting-object', files[i]!.path);
      n++; i++;
    }
    if (i < files.length) { await c.commit({ phase: 'verify', cursor: { i } }); return advance(i, files.length); }
    await c.commit({ phase: 'readback', cursor: { i: 0 } }, sealStatements(c.s.db, c.rv, attempt, t.now().toISOString()));
    return advance(files.length, files.length);
  }

  /** The stored version's head and file rows, checked as the readback of a stored package checks them. */
  async function storedHead(c: Ctx, expect: 'rows' | 'head'): Promise<{ version: VersionRow; rows: FileRow[] } | Out> {
    const { s } = c;
    const version = await s.db.prepare(VERSION_HEAD).bind(c.rv, c.req.caseId).first<VersionRow>();
    if (!version || version.state !== 'stored' || version.case_id !== c.req.caseId || version.manifest_sha256 !== c.req.identity.manifestSha256) integrity();
    const v = version!;
    if (!size(v.package_bytes) || v.package_bytes > b.maxPackageBytes || !size(v.expected_files) || v.expected_files > b.maxPackageFiles
      || !size(v.expected_documents) || v.expected_documents > b.maxDocuments || !size(v.expected_assets) || !size(v.expected_seeds)) integrity();
    if (expect === 'head') return { version: v, rows: [] };
    const { results: rows } = await s.db.prepare('SELECT path, sha256, size, object_key FROM rs_package_file WHERE version_id = ? ORDER BY path LIMIT ?').bind(c.rv, b.maxPackageFiles + 1).all<FileRow>();
    const total = rows.reduce((n, f) => n + f.size, 0);
    if (rows.length !== v.expected_files || rows.length > b.maxPackageFiles || !size(total) || total !== v.package_bytes || total > b.maxPackageBytes
      || new Set(rows.map((f) => f.path)).size !== rows.length
      || rows.some((f) => !size(f.size) || f.size > b.maxPackageFileBytes || !/^[0-9a-f]{64}$/.test(f.sha256) || f.object_key !== packageKey(c.rv, f.sha256))) integrity();
    const listed = listing(c);
    if (rows.length !== listed.length || rows.some((f, k) => f.path !== listed[k]!.path || f.size !== listed[k]!.size || f.sha256 !== listed[k]!.sha256)) integrity();
    return { version: v, rows };
  }

  /** readback: the stored previews, read back and checked, a bounded number at a time. */
  async function readback(c: Ctx): Promise<Out> {
    const head = await storedHead(c, 'rows');
    if ('kind' in head) return head;
    const previews = head.rows.filter((f) => c.req.pkg.files.get(f.path) && !isStructured(c, f.path));
    let i = Number(c.run.cursor.i ?? 0), n = 0, bytes = 0;
    const meta = i === 0 ? { ...c.run.meta, headSha: await sha256Canonical(head.version) } : c.run.meta;
    if (i > 0 && c.run.meta.headSha !== await sha256Canonical(head.version)) integrity();
    const batch: FileRow[] = [];
    while (i + batch.length < previews.length && batch.length < bounds.objectsPerStep && (batch.length === 0 || (bytes < bounds.bytesPerStep && t.clock() - c.started < bounds.wallMsPerStep))) {
      const f = previews[i + batch.length]!;
      batch.push(f); bytes += f.size; n++;
    }
    const denied = batch.length ? await admit(c, batch.length, bytes) : null;
    if (denied) return denied;
    await pool(batch, async (f) => {
      const r = await verifiedRead(c.s.bucket, f.object_key, f, b.maxPackageFileBytes);
      if (r.kind === 'unreachable') unavailable();
      if (r.kind !== 'ok') integrity();
      if (r.kind === 'ok' && !(c.req.pkg.files.get(f.path)!.pdf === (r.bytes.length >= 5 && new TextDecoder().decode(r.bytes.subarray(0, 5)) === '%PDF-'))) integrity();
    });
    i += batch.length;
    await c.commit(i >= previews.length ? { phase: 'originals-d', cursor: { after: '', n: 0 }, meta } : { phase: 'readback', cursor: { i }, meta });
    return advance(i, previews.length);
  }
  /** A structured (non-preview) file is one the manifest lists with a role other than `preview`. */
  const structuredPaths = new WeakMap<object, Set<string>>();
  function isStructured(c: Ctx, path: string): boolean {
    let set = structuredPaths.get(c.req.pkg.manifest);
    if (!set) {
      const m = JSON.parse(new TextDecoder().decode(c.req.pkg.manifest)) as { files: { path: string; role: string }[] };
      set = new Set(m.files.filter((f) => f.role !== 'preview').map((f) => f.path));
      structuredPaths.set(c.req.pkg.manifest, set);
    }
    return set.has(path);
  }

  /** final: the stored package read back whole (without its previews), validated once more against the facts after storage, and answered. */
  async function final(c: Ctx): Promise<Out> {
    const { req, s } = c, rv = c.rv;
    const head = await storedHead(c, 'rows');
    if ('kind' in head) return head;
    const { version, rows: fileRows } = head;
    if (c.run.meta.headSha !== undefined && c.run.meta.headSha !== await sha256Canonical(version)) integrity();
    const structured = fileRows.filter((f) => isStructured(c, f.path) || f.path === 'manifest.json');
    const read = await pool(structured, async (f) => {
      const r = await verifiedRead(s.bucket, f.object_key, f, b.maxPackageFileBytes);
      if (r.kind === 'unreachable') unavailable();
      if (r.kind !== 'ok') integrity();
      return [f.path, r.kind === 'ok' ? r.bytes : integrity()] as const;
    });
    const files = new Map<string, Uint8Array>(read);
    const held = new Map<string, HeldFile>(fileRows.filter((f) => !isStructured(c, f.path) && f.path !== 'manifest.json').map((f) => [f.path, { size: f.size, sha256: f.sha256, pdf: req.pkg.files.get(f.path)!.pdf }] as const));
    if (!verifyCandidateBytes(files, { resultsVersion: rv, manifestSha256: req.identity.manifestSha256 }, held).ok) integrity();
    const inspected = inspectPackage(files, req.caseId, held);
    if (!inspected.ok || inspected.value.inputRevisionId !== version.input_revision_id) integrity();
    await loadVerifiedModel(s.db, rv);
    const prepared = preparePackage(files, held);
    if (!prepared.ok) return refuse('integrity', ...prepared.problems);
    const facts = {
      b: factMap(await allFacts(s.db, c.id, c.run.epoch, 'b')),
      d: factMap(await allFacts(s.db, c.id, c.run.epoch, 'd')),
    };
    const projected = prepared.project(facts.b);
    if (!projected.ok) return refuse('integrity', ...projected.problems);
    if (await readModelDigest(projected.projection) !== version.read_model_sha256) integrity();
    // Pin the same stored head around the reads of the earlier steps and these; package identity includes case and input revision, not only hashes.
    const after = await s.db.prepare(VERSION_HEAD).bind(rv, req.caseId).first<VersionRow>();
    if (!same(version, after)) integrity();
    const validated = validateHostedPackage({ files, held, originals: facts.b, limits: t.limits });
    const finalValidation = validateHostedPackage({ files, held, originals: facts.d, limits: t.limits });
    if (facts.d.size !== prepared.fileAssets.length || validated.result.verdict === 'reject' || finalValidation.result.verdict === 'reject'
      || finalValidation.result.diagnosticsSha256 !== validated.result.diagnosticsSha256 || !same(finalValidation.caseMismatch, validated.caseMismatch)) return refuse('validation-changed', 'originals or diagnostics changed after staging');
    const result = validated.result, c0 = result.candidate;
    let warnings: unknown;
    try { warnings = JSON.parse(version.warning_fingerprints); } catch { return refuse('integrity', 'malformed stored warnings'); }
    if (version.input_revision_id !== c0.inputRevisionId || version.verdict !== result.verdict || version.validator_version !== result.validatorVersion
      || version.diagnostics_sha256 !== result.diagnosticsSha256 || !same(warnings, result.warningFingerprints)) return refuse('validation-changed', 'stored validation is not this exact validation; immutable version was not changed');
    const outcome: Staged = { kind: 'staged', repeated: c.run.meta.repeated === true, resultsVersion: req.identity.resultsVersion, manifestSha256: version.manifest_sha256, inputRevisionId: version.input_revision_id,
      verdict: version.verdict, validatorVersion: version.validator_version, diagnosticsSha256: version.diagnostics_sha256, warningFingerprints: warnings as string[], caseMismatch: validated.caseMismatch };
    await t.audit(req.caseId, rv, 'results.native-stage', 'succeeded');
    if (!same(await scope(c).release(rv), version)) integrity();
    await c.commit({ phase: 'done', outcome });
    return { kind: 'done', outcome };
  }
  const scope = (c: Ctx) => c.scope;

  const HANDLERS: Record<StepPhase, (c: Ctx) => Promise<Out>> = {
    plan, 'originals-a': originalsA, 'validate-a': validateA, 'originals-b': independent('b', 'begin', 'originals-b'), begin, rows, objects, verify, readback,
    'originals-d': independent('d', 'final', 'originals-d'), final, done: async () => { throw contractError('integrity'); },
  };
  return { step };
}
