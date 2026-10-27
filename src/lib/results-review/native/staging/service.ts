import { codeOf, contractError } from '../../../server/runtime/errors.ts';
import type { CaseId } from '../../../server/runtime/contracts.ts';
import { sha256Bytes, sha256Canonical } from '../digest.ts';
import type { NativeCandidateRepository, NativeImportBudget, Scoped, SqlCondition } from '../ports.ts';
import type { RequestBudget } from '../budget.ts';
import type { AdmittedOperator, ImportOutcome, ImportRequest } from '../service.ts';
import { checkManifest, type ManifestListing } from './manifest.ts';
import { STAGED_BYTES_PER_CLIENT, STAGED_MISSING_LISTED, STAGED_SESSION_TTL_MS, STAGED_SWEEP_OBJECTS, stagedBatchCost, stagedBounds, type StagedBounds } from './limits.ts';
import type { StagingPorts, StagingSession } from './ports.ts';
import { stagedCompleteCost, type StagedPackageView, type StagingStatus, type StepBounds } from './steps.ts';

export type StagedRefusalCode =
  | 'invalid-request' | 'package-invalid' | 'wrong-case' | 'too-large' | 'operation-reused' | 'session-not-found'
  | 'file-not-in-manifest' | 'file-mismatch' | 'batch-too-large' | 'incomplete' | 'over-budget' | 'submission-not-found' | 'submission-not-finalized'
  | 'session-expired' | 'not-finished' | 'busy' | 'staging-quota';
export interface StagedRefused { kind: 'refused'; code: StagedRefusalCode; detail: readonly string[] }
export interface StagedProgress {
  kind: 'progress';
  /** `complete` once a candidate exists for this operation. */
  state: 'open' | 'complete';
  /** The session already existed (an open that was sent again). */
  repeated: boolean;
  operationId: string; resultsVersion: string; manifestSha256: string; candidateId: string | null;
  expectedFiles: number; acceptedFiles: number; expectedBytes: number; acceptedBytes: number;
  /** The first paths still to send, in path order (at most 512); `missingFiles` counts them all. */
  missing: readonly string[]; missingFiles: number;
  /** What the batch just answered did: files newly stored, and files that were already accepted and so left alone. */
  batch: { written: number; alreadyAccepted: number } | null;
}
export type StagedOutcome = StagedProgress | StagedRefused;
export type StagedCompleteOutcome = ImportOutcome | StagedRefused | StagingStatus;
/**
 * One step of the sweep of an import's staged objects. `operationId` is null when no session is due. `remaining` is 0 once the listing of
 * the operation's objects is exhausted and 1 while it is not: a listing does not count what is left.
 */
export type SweepOutcome = { kind: 'swept'; operationId: string | null; deleted: number; remaining: number; state: 'sweeping' | 'done' } | StagedRefused;

/** The chunked import. Authority is the same admitted operator the one-request import takes; every write is fenced as there. */
export interface StagedImport {
  readonly bounds: StagedBounds;
  open(a: AdmittedOperator, r: { operationId: string; submissionRevisionId: string; manifest: Uint8Array }): Promise<StagedOutcome>;
  put(a: AdmittedOperator, r: { operationId: string; files: ReadonlyMap<string, Uint8Array> }): Promise<StagedOutcome>;
  status(a: AdmittedOperator, r: { operationId: string }): Promise<StagedOutcome>;
  /** Stages the package in bounded, resumable steps; answers `staging` until the last step, then links the candidate as the one-request import does. */
  complete(a: AdmittedOperator, r: { operationId: string }): Promise<StagedCompleteOutcome>;
  /** One bounded step of deleting a finished or abandoned import's staged objects. A finished import has a candidate; an abandoned one is older than its time to live. */
  sweep(a: AdmittedOperator, r: { operationId: string }): Promise<SweepOutcome>;
  /**
   * The drain: one bounded sweep step for the session of this case that is due next, one under way, else a finished import, else the oldest
   * idle past its time to live. Called until it answers a null `operationId`.
   */
  sweepExpired(a: AdmittedOperator): Promise<SweepOutcome>;
}

/** What the one-request service already holds, handed over so the staged steps share its authority and its link path unchanged. */
export interface StagedDeps {
  clientId: string; budget: NativeImportBudget; staging: StagingPorts; repository: NativeCandidateRepository;
  requestBudget: Pick<RequestBudget, 'd1' | 'external' | 'subrequests'> | null;
  now(): Date;
  must(a: AdmittedOperator, access: 'read' | 'write'): void;
  /** A fresh session check and the operate grant as they stand now. */
  observe(a: AdmittedOperator): Promise<void>;
  /** The write fence: the live session, then the grant as SQL for the statement itself to hold. */
  fence(a: AdmittedOperator): Promise<SqlCondition | undefined>;
  fenced<T>(a: AdmittedOperator, f: () => Promise<T>): Promise<T>;
  answer<T>(a: AdmittedOperator, out: T): Promise<T>;
  importPackage(a: AdmittedOperator, r: ImportRequest): Promise<ImportOutcome>;
  /** The stepped import: runs bounded steps over the staged package and links when they are done. Null until a stepped stager is composed. */
  importStepped: null | ((a: AdmittedOperator, r: { operationId: string; submissionRevisionId: string; identity: { resultsVersion: string; manifestSha256: string }; pkg: StagedPackageView }) => Promise<ImportOutcome | StagingStatus | { kind: 'busy' }>);
  /** Bounds of one step, for the cost check against the plan's request budget. */
  stepBounds: StepBounds | null;
  /** The refusal the one-request import gives for a submission revision that is not a finalized one of this case, or null when it is. */
  submissionRefusal(caseId: CaseId, revisionId: string): Promise<{ code: string; detail: readonly string[] } | null>;
  repeated(a: AdmittedOperator, existing: Awaited<ReturnType<NativeCandidateRepository['byOperation']>> & object): Promise<ImportOutcome>;
}

const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d];
/** The validator's own preview test: the bytes open with `%PDF-`. */
const isPdf = (b: Uint8Array) => b.length >= 5 && PDF_HEAD.every((c, i) => b[i] === c);
const refuse = (code: StagedRefusalCode, ...detail: string[]): StagedRefused => ({ kind: 'refused', code, detail });
const HEX = /^[0-9a-f]{64}$/;

/**
 * Whether a request's calls fit the plan. `external` is the identity provider's checks. With a `subrequests` pool every D1 query, R2 call
 * and fetch shares it; without one, R2 calls share `external`.
 */
function overPlan(c: { d1: number; r2: number; external: number }, rb: Pick<RequestBudget, 'd1' | 'external' | 'subrequests'>): string | null {
  const pool = rb.subrequests;
  const fits = c.d1 <= rb.d1 && (pool === undefined ? c.external + c.r2 <= rb.external : c.external <= rb.external && c.d1 + c.r2 + c.external <= pool);
  return fits ? null : `this needs up to ${c.d1} D1 calls, ${c.r2} R2 calls and ${c.external} identity checks; one request here may make ${rb.d1} D1 calls, ${rb.external} identity checks${pool === undefined ? ' (R2 calls included)' : ` and ${pool} subrequests in all`}`;
}
/** At most six simultaneous connections per Worker invocation. */
const READ_CONCURRENCY = 6;

async function pool<T, R>(items: readonly T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!);
  }));
  return out;
}

export function createStagedImport(d: StagedDeps): StagedImport {
  const { ledger, store } = d.staging;
  const bounds = stagedBounds(d.budget, { maxBatchFiles: d.staging.maxBatchFiles });
  const scope = (a: AdmittedOperator): Scoped => ({ clientId: d.clientId as Scoped['clientId'], caseId: a.caseId });
  const operator = (a: AdmittedOperator) => ({ issuer: a.principal.issuer, subject: a.principal.subject });
  const limits = () => ({ maxFiles: d.budget.maxFiles, maxFileBytes: d.budget.maxFileBytes, maxPackageBytes: d.budget.maxPackageBytes, maxBatchBytes: bounds.maxBatchBytes });

  /**
   * The manifest the session opened, read back from the store and checked against its recorded digest and the committed schema. An open that
   * died after its session row and before its manifest object leaves none: sending the open again stores it.
   */
  async function listing(a: AdmittedOperator, s: StagingSession): Promise<{ bytes: Uint8Array; listing: ManifestListing } | StagedRefused> {
    let bytes: Uint8Array;
    try { bytes = await store.read({ ...scope(a), operationId: s.operationId, sha256: s.manifestSha256, size: s.manifestSize }); } catch (e) {
      if (codeOf(e) === 'not-found') return refuse('incomplete', 'the manifest of this import is not stored; send the open again');
      throw e;
    }
    const checked = checkManifest(bytes, a.caseId, limits());
    if (!checked.ok || checked.value.manifestSha256 !== s.manifestSha256 || checked.value.manifest.resultsVersion !== s.resultsVersion) throw contractError('integrity', false);
    return { bytes, listing: checked.value };
  }
  async function progress(a: AdmittedOperator, s: StagingSession, listed: ManifestListing, repeated: boolean, batch: StagedProgress['batch']): Promise<StagedProgress> {
    const have = await ledger.accepted({ ...scope(a), operationId: s.operationId, limit: s.expectedFiles + 1 });
    const done = new Set(have.map((r) => r.path));
    const missing = [...listed.files.keys()].filter((p) => !done.has(p)).sort();
    const existing = await d.repository.byOperation({ ...scope(a), operationId: s.operationId });
    return { kind: 'progress', state: existing ? 'complete' : 'open', repeated, operationId: s.operationId, resultsVersion: s.resultsVersion, manifestSha256: s.manifestSha256,
      candidateId: existing?.candidateId ?? null, expectedFiles: s.expectedFiles, acceptedFiles: have.length, expectedBytes: s.expectedBytes,
      acceptedBytes: have.reduce((n, r) => n + r.size, 0), missing: missing.slice(0, STAGED_MISSING_LISTED), missingFiles: missing.length, batch };
  }

  const session = async (a: AdmittedOperator, operationId: string) => (await ledger.session({ ...scope(a), operationId })) ?? null;
  const costRefusal = (files: number): StagedRefused | null => {
    const rb = d.requestBudget;
    if (!rb) return null;
    // stagedBatchCost's `external` counts its R2 calls too.
    const c = stagedBatchCost(files, d.staging.rowsPerBatch);
    const over = overPlan({ d1: c.d1, r2: c.r2, external: c.external - c.r2 }, rb);
    return over ? refuse('over-budget', `a batch of ${files} files: ${over}`) : null;
  };

  const ttl = d.staging.sessionTtlMs ?? STAGED_SESSION_TTL_MS, sweepObjects = Math.max(1, Math.min(d.staging.sweepObjects ?? STAGED_SWEEP_OBJECTS, 1000));
  const maxStagedBytes = d.staging.maxStagedBytes ?? STAGED_BYTES_PER_CLIENT;
  /** Sessions opened before this, and idle since, are past their time to live. */
  const liveFrom = () => new Date(d.now().getTime() - ttl).toISOString();

  /**
   * One bounded step of deleting an operation's staged objects: a page of the listing of its own key prefix, so an object written before its
   * row, or whose row was never written, is deleted too. A finished import (it has a candidate) and an abandoned one (idle past its time to
   * live) may be swept; anything else is still wanted. No other operation's object is under the prefix. The sweep record, written first, is
   * the tombstone: no file is accepted under the operation once it exists, and a writer that lost the race deletes what it wrote. Deleting is
   * idempotent and the position moves only from where the step read it, so a step that dies, or runs twice at once, is simply repeated.
   */
  async function sweepOne(a: AdmittedOperator, operationId: string): Promise<SweepOutcome> {
    d.must(a, 'write');
    const s = await session(a, operationId);
    if (!s) return d.answer(a, refuse('session-not-found', 'no staged import was opened under this operation id'));
    const notFinished = () => d.answer(a, refuse('not-finished', 'the import has no candidate yet and was active inside its time to live'));
    let c = await ledger.cleanup({ ...scope(a), operationId });
    if (!c) {
      const finished = (await d.repository.byOperation({ ...scope(a), operationId })) !== null;
      if (!finished && !(await ledger.idle({ ...scope(a), operationId, idleFrom: liveFrom() }))) return notFinished();
      await d.observe(a);
      const guard = await d.fence(a);
      c = await d.fenced(a, () => ledger.startCleanup({ ...scope(a), operationId, reason: finished ? 'complete' : 'abandoned', at: d.now().toISOString(), idleFrom: liveFrom(), guard }));
      if (!c) return notFinished();
    }
    if (c.state === 'done') return d.answer(a, { kind: 'swept', operationId, deleted: 0, remaining: 0, state: 'done' });
    // The tombstone fences new reservations. Wait before the FIRST listing until all earlier puts have settled, so no late write
    // can land behind this cursor or after capacity is released. A clock timeout cannot prove an HTTP writer has stopped.
    if (await ledger.writing({ ...scope(a), operationId })) return d.answer(a, { kind: 'swept', operationId, deleted: 0, remaining: 1, state: 'sweeping' });
    await d.observe(a);
    const page = await store.list({ ...scope(a), operationId, after: c.afterKey, limit: sweepObjects });
    let deleted = 0;
    for (const name of page.names) {
      if (!HEX.test(name)) continue;
      await store.delete({ ...scope(a), operationId, sha256: name });
      deleted++;
    }
    const afterKey = page.names.length > 0 ? page.names[page.names.length - 1]! : c.afterKey;
    const guard = await d.fence(a);
    await d.fenced(a, () => ledger.advanceCleanup({ ...scope(a), operationId, from: c!.afterKey, afterKey, swept: c!.swept + deleted, done: !page.more, at: d.now().toISOString(), guard }));
    return d.answer(a, { kind: 'swept', operationId, deleted, remaining: page.more ? 1 : 0, state: page.more ? 'sweeping' : 'done' });
  }

  async function sweepNext(a: AdmittedOperator): Promise<SweepOutcome> {
    d.must(a, 'write');
    const next = await ledger.nextDue({ ...scope(a), idleFrom: liveFrom() });
    if (!next) return d.answer(a, { kind: 'swept', operationId: null, deleted: 0, remaining: 0, state: 'done' });
    return sweepOne(a, next.operationId);
  }
  /** Whether one sweep step fits the plan's request budget alongside the call that triggers it: about 20 D1 calls, a listing and its deletes. */
  const sweepFits = () => !d.requestBudget || !overPlan({ d1: 40, r2: sweepObjects + 2, external: 20 }, d.requestBudget);

  /** Deletes what a writer stored under an operation whose sweep began first. Best effort: the sweep's own listing finds anything left. */
  const unwrite = async (a: AdmittedOperator, operationId: string, sha256s: readonly string[]) => {
    for (const sha256 of new Set(sha256s)) await store.delete({ ...scope(a), operationId, sha256 }).catch(() => undefined);
  };
  const swept = (a: AdmittedOperator) => d.answer(a, refuse('session-expired', 'the staged files of this import were deleted'));

  return {
    bounds,

    async open(a, r) {
      d.must(a, 'write');
      const checked = checkManifest(r.manifest, a.caseId, limits());
      if (!checked.ok) return d.answer(a, refuse(checked.code, ...checked.detail));
      const m = checked.value;
      // Learn that the submission cannot be linked before any byte is sent, not at completion.
      const gone = await d.submissionRefusal(a.caseId, r.submissionRevisionId);
      if (gone) return d.answer(a, refuse(gone.code === 'submission-not-finalized' ? 'submission-not-finalized' : 'submission-not-found', ...gone.detail));
      const requestSha256 = await sha256Canonical({ kind: 'staged-import', submissionRevisionId: r.submissionRevisionId, manifestSha256: m.manifestSha256 });
      // One bounded step of the drain, before the cap is checked, so a client at its cap still makes room. Best effort: the open does not wait on it.
      if (sweepFits()) await sweepNext(a).catch(() => undefined);
      // The session row first, inside the client's cap, then the manifest object: nothing is stored that no row accounts for, and a sweep
      // finds the manifest under the operation's prefix.
      await d.observe(a);
      const guard = await d.fence(a);
      const opened = await d.fenced(a, () => ledger.open({ ...scope(a), operationId: r.operationId, submissionRevisionId: r.submissionRevisionId, manifestSha256: m.manifestSha256, manifestSize: r.manifest.byteLength, resultsVersion: m.manifest.resultsVersion,
        expectedFiles: m.files.size, expectedBytes: m.listedBytes, requestSha256, operator: operator(a), at: d.now().toISOString(), maxStagedBytes, guard }));
      if (opened.kind === 'operation-reused') return d.answer(a, refuse('operation-reused', 'this operation id was already used for a different request'));
      if (opened.kind === 'over-quota') return d.answer(a, refuse('staging-quota', `staged imports of this deployment hold ${opened.held} bytes; with this one's ${m.listedBytes + r.manifest.byteLength} that is more than the ${maxStagedBytes} they may hold`, 'finish an import, or sweep a finished or abandoned one, then open again; an unsettled writer keeps its capacity reserved even past the idle TTL'));
      const key = { ...scope(a), operationId: r.operationId };
      if (await ledger.cleanup(key)) return swept(a);
      await d.observe(a);
      const writerId = await d.fenced(a, async () => ledger.beginWrite({ ...key, guard: await d.fence(a) }));
      if (!writerId) return swept(a);
      try { await store.put({ ...key, sha256: m.manifestSha256, bytes: r.manifest }); }
      finally { await ledger.endWrite({ ...key, writerId }); }
      // A sweep that began while the manifest was written may have listed past it.
      if (await ledger.cleanup(key)) { await unwrite(a, r.operationId, [m.manifestSha256]); return swept(a); }
      return d.answer(a, await progress(a, opened.session, m, opened.kind === 'repeated', null));
    },

    async put(a, r) {
      d.must(a, 'write');
      const bytes = [...r.files.values()].reduce((n, b) => n + b.byteLength, 0);
      if (r.files.size === 0) return d.answer(a, refuse('invalid-request', 'a batch carries at least one file'));
      if (r.files.size > bounds.maxBatchFiles || bytes > bounds.maxBatchBytes) return d.answer(a, refuse('batch-too-large', `a batch carries at most ${bounds.maxBatchFiles} files and ${bounds.maxBatchBytes} bytes`));
      const over = costRefusal(r.files.size);
      if (over) return d.answer(a, over);
      const s = await session(a, r.operationId);
      if (!s) return d.answer(a, refuse('session-not-found', 'no staged import was opened under this operation id'));
      if (await ledger.cleanup({ ...scope(a), operationId: r.operationId })) return swept(a);
      const read = await listing(a, s);
      if ('kind' in read) return d.answer(a, read);
      const listed = read.listing;

      // Every file is checked against the manifest before any is written, so a batch with one bad file changes nothing.
      const unlisted: string[] = [], mismatched: string[] = [];
      for (const [path, data] of r.files) {
        const entry = listed.files.get(path);
        if (!entry) { unlisted.push(path.slice(0, 200)); continue; }
        if (data.byteLength !== entry.size) { mismatched.push(`${path}: ${data.byteLength} bytes, the manifest lists ${entry.size}`); continue; }
        if (await sha256Bytes(data) !== entry.sha256) mismatched.push(`${path}: sha256 differs from the manifest`);
      }
      if (unlisted.length) return d.answer(a, refuse('file-not-in-manifest', ...unlisted.slice(0, 20)));
      if (mismatched.length) return d.answer(a, refuse('file-mismatch', ...mismatched.slice(0, 20)));

      const have = new Map((await ledger.accepted({ ...scope(a), operationId: r.operationId, paths: [...r.files.keys()] })).map((x) => [x.path, x]));
      const fresh = [...r.files].filter(([path]) => !have.has(path)).map(([path, data]) => ({ path, data, ...listed.files.get(path)! }));
      if (fresh.length > 0) {
        await d.observe(a);
        const key = { ...scope(a), operationId: r.operationId };
        const writerId = await d.fenced(a, async () => ledger.beginWrite({ ...key, guard: await d.fence(a) }));
        if (!writerId) return swept(a);
        // One reservation covers this sequential batch. Release only after every started R2 put has settled, on success OR failure.
        // If the isolate is killed before settlement is recorded, the durable reservation keeps capacity held rather than guessing.
        try { for (const f of fresh) await store.put({ ...key, sha256: f.sha256, bytes: f.data }); }
        finally { await ledger.endWrite({ ...key, writerId }); }
        const guard = await d.fence(a);
        const accepted = await d.fenced(a, () => ledger.accept({ ...scope(a), operationId: r.operationId, rows: fresh.map(({ path, sha256, size, data }) => ({ path, sha256, size, pdf: isPdf(data) })), at: d.now().toISOString(), guard }));
        // A sweep began after the check above: nothing more is accepted, and what this batch wrote is removed again.
        if (accepted === 'swept') { await unwrite(a, r.operationId, fresh.map((f) => f.sha256)); return swept(a); }
      }
      return d.answer(a, await progress(a, s, listed, false, { written: fresh.length, alreadyAccepted: r.files.size - fresh.length }));
    },

    async status(a, r) {
      d.must(a, 'read');
      const s = await session(a, r.operationId);
      if (!s) return d.answer(a, refuse('session-not-found', 'no staged import was opened under this operation id'));
      if (await ledger.cleanup({ ...scope(a), operationId: r.operationId })) {
        // The staged files were swept. A finished import still reports its candidate; an abandoned one has nothing left to continue.
        const existing = await d.repository.byOperation({ ...scope(a), operationId: r.operationId });
        if (!existing) return swept(a);
        const t = await ledger.totals({ ...scope(a), operationId: r.operationId });
        return d.answer(a, { kind: 'progress', state: 'complete', repeated: false, operationId: s.operationId, resultsVersion: s.resultsVersion, manifestSha256: s.manifestSha256, candidateId: existing.candidateId,
          expectedFiles: s.expectedFiles, acceptedFiles: t.files, expectedBytes: s.expectedBytes, acceptedBytes: t.bytes, missing: [], missingFiles: 0, batch: null });
      }
      const read = await listing(a, s);
      return d.answer(a, 'kind' in read ? read : await progress(a, s, read.listing, false, null));
    },

    async complete(a, r) {
      d.must(a, 'write');
      const s = await session(a, r.operationId);
      if (!s) return d.answer(a, refuse('session-not-found', 'no staged import was opened under this operation id'));
      // A candidate already linked under this operation is answered as the one-request import answers a repeat, without reading a file.
      const existing = await d.repository.byOperation({ ...scope(a), operationId: r.operationId });
      if (existing) return d.repeated(a, existing);
      if (await ledger.cleanup({ ...scope(a), operationId: r.operationId })) return swept(a);
      const read = await listing(a, s);
      if ('kind' in read) return d.answer(a, read);
      const { bytes: manifest, listing: listed } = read;
      const have = await ledger.accepted({ ...scope(a), operationId: r.operationId, limit: s.expectedFiles + 1 });
      const done = new Set(have.map((x) => x.path));
      const missing = [...listed.files.keys()].filter((p) => !done.has(p)).sort();
      if (missing.length > 0) return d.answer(a, refuse('incomplete', `${missing.length} of ${s.expectedFiles} files are not accepted yet`, ...missing.slice(0, 20)));

      if (d.importStepped) {
        // Bounded steps over the staged package: no step holds it whole, and each is safe to repeat. A request whose steps and link could
        // make more D1, R2 or identity calls than one request here may is refused before anything is written.
        const rb = d.requestBudget;
        if (rb && d.stepBounds) {
          const over = overPlan(stagedCompleteCost(d.stepBounds, d.staging.rowsPerBatch), rb);
          if (over) return d.answer(a, refuse('over-budget', `${d.stepBounds.stepsPerRequest} step(s) and the link of one request: ${over}`));
        }
        await d.observe(a);
        const byPath = new Map(have.map((x) => [x.path, x] as const));
        const view: StagedPackageView = {
          manifest,
          files: new Map(have.map((x) => [x.path, { sha256: x.sha256, size: x.size, pdf: x.pdf }] as const)),
          read: async (path) => {
            if (path === 'manifest.json') return manifest;
            const f = byPath.get(path);
            if (!f) throw contractError('integrity', false);
            // An accepted file that is gone was swept or lost: the staged package no longer verifies.
            return store.read({ ...scope(a), operationId: r.operationId, sha256: f.sha256, size: f.size }).catch((e) => { throw codeOf(e) === 'not-found' ? contractError('integrity', false) : e; });
          },
        };
        const out = await d.importStepped(a, { operationId: r.operationId, submissionRevisionId: s.submissionRevisionId, identity: { resultsVersion: s.resultsVersion, manifestSha256: s.manifestSha256 }, pkg: view });
        return out.kind === 'busy' ? d.answer(a, refuse('busy', 'another request is running a step of this import; try again shortly')) : out;
      }

      // Without a stepped stager the whole verified package goes to the one-request path: only for a composition that has none.
      // Reading the staged package back is a read of every file: refuse it up front when this request cannot finish it.
      if (d.requestBudget && listed.files.size + 12 > d.requestBudget.external) return d.answer(a, refuse('over-budget', `reading ${listed.files.size + 1} staged files needs more subrequests than one request here may make (${d.requestBudget.external})`));
      await d.observe(a);
      const files = new Map<string, Uint8Array>([['manifest.json', manifest]]);
      const entries = [...listed.files].sort(([x], [y]) => (x < y ? -1 : 1));
      const bytes = await pool(entries, async ([path, e]) => [path, await store.read({ ...scope(a), operationId: r.operationId, sha256: e.sha256, size: e.size })] as const);
      for (const [path, data] of bytes) files.set(path, data);
      return d.importPackage(a, { operationId: r.operationId, submissionRevisionId: s.submissionRevisionId, files });
    },

    sweep: (a, r) => sweepOne(a, r.operationId),

    sweepExpired: (a) => sweepNext(a),
  };
}
