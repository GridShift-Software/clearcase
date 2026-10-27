import { contractError } from '../../../server/runtime/errors.ts';
import type { CaseId } from '../../../server/runtime/contracts.ts';
import { sha256Bytes, sha256Canonical } from '../digest.ts';
import type { NativeCandidateRepository, NativeImportBudget, Scoped, SqlCondition } from '../ports.ts';
import type { RequestBudget } from '../budget.ts';
import type { AdmittedOperator, ImportOutcome, ImportRequest } from '../service.ts';
import { checkManifest, type ManifestListing } from './manifest.ts';
import { STAGED_MISSING_LISTED, stagedBatchCost, stagedBounds, type StagedBounds } from './limits.ts';
import type { StagingPorts, StagingSession } from './ports.ts';

export type StagedRefusalCode =
  | 'invalid-request' | 'package-invalid' | 'wrong-case' | 'too-large' | 'operation-reused' | 'session-not-found'
  | 'file-not-in-manifest' | 'file-mismatch' | 'batch-too-large' | 'incomplete' | 'over-budget' | 'submission-not-found' | 'submission-not-finalized';
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
export type StagedCompleteOutcome = ImportOutcome | StagedRefused;

/** The chunked import. Authority is the same admitted operator the one-request import takes; every write is fenced as there. */
export interface StagedImport {
  readonly bounds: StagedBounds;
  open(a: AdmittedOperator, r: { operationId: string; submissionRevisionId: string; manifest: Uint8Array }): Promise<StagedOutcome>;
  put(a: AdmittedOperator, r: { operationId: string; files: ReadonlyMap<string, Uint8Array> }): Promise<StagedOutcome>;
  status(a: AdmittedOperator, r: { operationId: string }): Promise<StagedOutcome>;
  complete(a: AdmittedOperator, r: { operationId: string }): Promise<StagedCompleteOutcome>;
}

/** What the one-request service already holds, handed over so the staged steps share its authority and its link path unchanged. */
export interface StagedDeps {
  clientId: string; budget: NativeImportBudget; staging: StagingPorts; repository: NativeCandidateRepository;
  requestBudget: Pick<RequestBudget, 'd1' | 'external'> | null;
  now(): Date;
  must(a: AdmittedOperator, access: 'read' | 'write'): void;
  /** A fresh session check and the operate grant as they stand now. */
  observe(a: AdmittedOperator): Promise<void>;
  /** The write fence: the live session, then the grant as SQL for the statement itself to hold. */
  fence(a: AdmittedOperator): Promise<SqlCondition | undefined>;
  fenced<T>(a: AdmittedOperator, f: () => Promise<T>): Promise<T>;
  answer<T>(a: AdmittedOperator, out: T): Promise<T>;
  importPackage(a: AdmittedOperator, r: ImportRequest): Promise<ImportOutcome>;
  /** The refusal the one-request import gives for a submission revision that is not a finalized one of this case, or null when it is. */
  submissionRefusal(caseId: CaseId, revisionId: string): Promise<{ code: string; detail: readonly string[] } | null>;
  repeated(a: AdmittedOperator, existing: Awaited<ReturnType<NativeCandidateRepository['byOperation']>> & object): Promise<ImportOutcome>;
}

const refuse = (code: StagedRefusalCode, ...detail: string[]): StagedRefused => ({ kind: 'refused', code, detail });
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

  /** The manifest the session opened, read back from the store and checked against its recorded digest and the committed schema. */
  async function listing(a: AdmittedOperator, s: StagingSession): Promise<{ bytes: Uint8Array; listing: ManifestListing }> {
    const bytes = await store.read({ ...scope(a), sha256: s.manifestSha256, size: s.manifestSize });
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
    const c = stagedBatchCost(files, d.staging.rowsPerBatch);
    return c.d1 <= rb.d1 && c.external <= rb.external ? null
      : refuse('over-budget', `a batch of ${files} files needs up to ${c.d1} D1 calls and ${c.external} subrequests; one request here may make ${rb.d1} and ${rb.external}`);
  };

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
      // The manifest object first, then the session row: a session always has its manifest.
      await d.observe(a);
      await store.put({ ...scope(a), sha256: m.manifestSha256, bytes: r.manifest });
      const guard = await d.fence(a);
      const opened = await d.fenced(a, () => ledger.open({ ...scope(a), operationId: r.operationId, submissionRevisionId: r.submissionRevisionId, manifestSha256: m.manifestSha256, manifestSize: r.manifest.byteLength, resultsVersion: m.manifest.resultsVersion,
        expectedFiles: m.files.size, expectedBytes: m.listedBytes, requestSha256, operator: operator(a), at: d.now().toISOString(), guard }));
      if (opened.kind === 'operation-reused') return d.answer(a, refuse('operation-reused', 'this operation id was already used for a different request'));
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
      const { listing: listed } = await listing(a, s);

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
        // Objects first, rows second: a row always has its object, and an object without a row is found again and left alone.
        for (const f of fresh) await store.put({ ...scope(a), sha256: f.sha256, bytes: f.data });
        const guard = await d.fence(a);
        await d.fenced(a, () => ledger.accept({ ...scope(a), operationId: r.operationId, rows: fresh.map(({ path, sha256, size }) => ({ path, sha256, size })), at: d.now().toISOString(), guard }));
      }
      return d.answer(a, await progress(a, s, listed, false, { written: fresh.length, alreadyAccepted: r.files.size - fresh.length }));
    },

    async status(a, r) {
      d.must(a, 'read');
      const s = await session(a, r.operationId);
      if (!s) return d.answer(a, refuse('session-not-found', 'no staged import was opened under this operation id'));
      const { listing: listed } = await listing(a, s);
      return d.answer(a, await progress(a, s, listed, false, null));
    },

    async complete(a, r) {
      d.must(a, 'write');
      const s = await session(a, r.operationId);
      if (!s) return d.answer(a, refuse('session-not-found', 'no staged import was opened under this operation id'));
      // A candidate already linked under this operation is answered as the one-request import answers a repeat, without reading a file.
      const existing = await d.repository.byOperation({ ...scope(a), operationId: r.operationId });
      if (existing) return d.repeated(a, existing);
      const { bytes: manifest, listing: listed } = await listing(a, s);
      const have = await ledger.accepted({ ...scope(a), operationId: r.operationId, limit: s.expectedFiles + 1 });
      const done = new Set(have.map((x) => x.path));
      const missing = [...listed.files.keys()].filter((p) => !done.has(p)).sort();
      if (missing.length > 0) return d.answer(a, refuse('incomplete', `${missing.length} of ${s.expectedFiles} files are not accepted yet`, ...missing.slice(0, 20)));
      // Reading the staged package back is a read of every file: refuse it up front when this request cannot finish it.
      if (d.requestBudget && listed.files.size + 12 > d.requestBudget.external) return d.answer(a, refuse('over-budget', `reading ${listed.files.size + 1} staged files needs more subrequests than one request here may make (${d.requestBudget.external})`));
      await d.observe(a);
      const files = new Map<string, Uint8Array>([['manifest.json', manifest]]);
      const entries = [...listed.files].sort(([x], [y]) => (x < y ? -1 : 1));
      const read = await pool(entries, async ([path, e]) => [path, await store.read({ ...scope(a), sha256: e.sha256, size: e.size })] as const);
      for (const [path, data] of read) files.set(path, data);
      return d.importPackage(a, { operationId: r.operationId, submissionRevisionId: s.submissionRevisionId, files });
    },
  };
}
