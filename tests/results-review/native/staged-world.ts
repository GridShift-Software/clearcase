// Test doubles for the chunked (staged) import: a service over the real D1 repositories on the node:sqlite stand-in, an in-memory
// R2, and fault injectors that stop the "process" at a chosen R2 or D1 write. Not Cloudflare; a pass here is component evidence.
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateCorpus } from '../../../scripts/fixtures/synthetic/corpus.ts';
import type { CloudD1, CloudD1Statement, CloudR2, CloudR2Body, CloudR2Head } from '../../../src/lib/storage/cloud/bindings.ts';
import { d1NativeCandidateRepository, createNativeResultsImport, submissionSnapshotReader, type NativeD1, type NativeImportPorts, type CandidateStager, type FinalizedSubmissionReader, type StageRequest } from '../../../src/lib/results-review/native/index.ts';
import { d1StagingLedger, r2StagingStore } from '../../../src/lib/results-review/native/staging/index.ts';
import { inspectPackage } from '../../../src/lib/results-review/native/package.ts';
import { finalizedSnapshotIdentity } from '../../../src/lib/submissions/snapshot-identity.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { CaseId } from '../../../src/lib/server/runtime/contracts.ts';
import { MemoryR2 } from '../../hosted-foundation/storage/doubles.ts';
import { AuditRecorder, CLIENT, NOW, SqliteD1, StoredPackages, ValidatingStager, operateAuthority, who } from './doubles.ts';
import { MIGRATIONS } from './harness.ts';

const root = path.join(import.meta.dirname, '../../..');
export const STAGING_MIGRATION = path.join(root, 'src/lib/results-review/native/migrations/0002_native_import_staging.sql');
export const STAGED_MIGRATIONS: readonly string[] = [...MIGRATIONS, STAGING_MIGRATION];

/** The synthetic poc corpus (`fixtures:generate --profile poc`), generated once outside /tmp and the checkout. */
export async function pocPackage(): Promise<{ caseId: string; files: Map<string, Uint8Array> }> {
  const dir = process.env.CLEARCASE_POC_DIR ?? path.join(os.homedir(), '.cache', 'clearcase-rx27', 'poc');
  try { statSync(path.join(dir, 'pkg', 'manifest.json')); } catch {
    mkdirSync(path.dirname(dir), { recursive: true });
    await generateCorpus({ out: dir, seed: '20261017', documents: 1689, profile: 'poc' });
  }
  const files = new Map<string, Uint8Array>();
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, 'pkg', rel))) {
      const p = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, 'pkg', p)).isDirectory()) walk(p); else files.set(p, new Uint8Array(readFileSync(path.join(dir, 'pkg', p))));
    }
  };
  walk('');
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!)) as { case: { id: string } };
  return { caseId: manifest.case.id, files };
}

/** A stager that checks nothing but the package identity; it records exactly the bytes it was given. */
export class RecordingStager implements CandidateStager {
  received: ReadonlyMap<string, Uint8Array> | null = null;
  calls = 0;
  async stage(a: StageRequest) {
    this.calls++;
    this.received = a.files;
    const p = inspectPackage(a.files, a.caseId);
    if (!p.ok) return { kind: 'refused' as const, reason: 'rejected', detail: p.detail };
    return { kind: 'staged' as const, repeated: false, resultsVersion: a.identity.resultsVersion, manifestSha256: a.identity.manifestSha256, inputRevisionId: p.value.inputRevisionId,
      verdict: 'accept' as const, validatorVersion: 'recording-stager/1', diagnosticsSha256: '0'.repeat(64), warningFingerprints: [] as string[], caseMismatch: [] as { ref: string; fingerprint: string }[] };
  }
}

/** A finalized submission of exactly the given original files, behind the trusted reader port. */
export async function submissionOf(caseId: string, files: readonly { path: string; sha256: string; size: number }[], revisionId = 'subrev-staged'): Promise<FinalizedSubmissionReader> {
  const manifest = Object.freeze({
    format: 'clearcase.submission-manifest/1' as const, clientId: CLIENT, caseId: id('case', caseId) as CaseId, revisionId, sequence: 1, operationId: 'op-submission', finalizedAt: NOW,
    files: Object.freeze(files.map((f, i) => Object.freeze({ path: f.path, filename: f.path.split('/').pop()!, mediaType: 'application/pdf', size: f.size, sha256: f.sha256, assetId: `asset-${i}` }))),
  });
  const identity = await finalizedSnapshotIdentity(manifest);
  const snapshot = { state: 'finalized' as const, manifest, storedManifestSha256: identity.sha256 as never, storedManifestBytes: identity.bytes };
  return { finalized: async (a) => (a.revisionId === revisionId && a.caseId === caseId ? snapshot : { state: 'absent' as const }) };
}

export class Killed extends Error { readonly where: string; constructor(where: string) { super(`killed ${where}`); this.where = where; } }
export type KillPhase = 'before-r2-put' | 'after-r2-put' | 'before-d1-rows' | 'after-d1-rows';
export const KILL_PHASES: readonly KillPhase[] = ['before-r2-put', 'after-r2-put', 'before-d1-rows', 'after-d1-rows'];
export interface Kill { phase: KillPhase; nth: number }

/** The durable state of a deployment: what survives when the process dies. */
export class Durable {
  readonly db = new SqliteD1(STAGED_MIGRATIONS);
  readonly r2 = new MemoryR2();
  readonly audit = new AuditRecorder();
  /** Every R2 put to a staged key, in order. */
  readonly stagedPuts: string[] = [];
  readonly counts = { r2: 0, d1: 0, rowBatches: 0 };
}

/** R2 that dies at the nth staged put: before it writes, or after it has written but before the caller hears. */
class ChaosR2 implements CloudR2 {
  private seen = 0;
  private readonly d: Durable;
  private readonly kill: Kill | null;
  constructor(d: Durable, kill: Kill | null) { this.d = d; this.kill = kill; }
  head(key: string): Promise<CloudR2Head | null> { this.d.counts.r2++; return this.d.r2.head(key); }
  get(key: string): Promise<CloudR2Body | null> { this.d.counts.r2++; return this.d.r2.get(key); }
  async put(key: string, value: Uint8Array, options: { sha256: string; onlyIf?: { etagDoesNotMatch: '*' } }) {
    this.d.counts.r2++;
    const nth = ++this.seen;
    const hit = this.kill && (this.kill.phase === 'before-r2-put' || this.kill.phase === 'after-r2-put') && nth === this.kill.nth;
    if (hit && this.kill!.phase === 'before-r2-put') throw new Killed('before-r2-put');
    const out = await this.d.r2.put(key, value, options);
    if (out) this.d.stagedPuts.push(key);
    if (hit) throw new Killed('after-r2-put');
    return out;
  }
}

/** D1 that dies at the nth batch of staged-file rows. */
class ChaosD1 implements NativeD1, CloudD1 {
  private seen = 0;
  private readonly sql = new WeakMap<object, string>();
  private readonly d: Durable;
  private readonly kill: Kill | null;
  constructor(d: Durable, kill: Kill | null) { this.d = d; this.kill = kill; }
  prepare(sql: string) {
    // bind() makes a new statement, so every statement the adapter can pass to batch() is tagged with its SQL. A D1 call is an
    // execution (first, all, run) or one batch; preparing and binding cost nothing.
    const tag = (statement: CloudD1Statement): CloudD1Statement => {
      this.sql.set(statement, sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => tag(bind(...values));
      for (const run of ['first', 'all', 'run'] as const) {
        const inner = (statement[run] as () => Promise<unknown>).bind(statement);
        (statement as unknown as Record<string, unknown>)[run] = () => { this.d.counts.d1++; return inner(); };
      }
      return statement;
    };
    return tag(this.d.db.prepare(sql)) as never;
  }
  async batch(statements: CloudD1Statement[]) {
    this.d.counts.d1++;
    const rows = statements.some((s) => /native_import_staged_file/.test(this.sql.get(s as object) ?? ''));
    const nth = rows ? ++this.seen : 0;
    if (rows) this.d.counts.rowBatches++;
    const hit = rows && this.kill && (this.kill.phase === 'before-d1-rows' || this.kill.phase === 'after-d1-rows') && nth === this.kill.nth;
    if (hit && this.kill!.phase === 'before-d1-rows') throw new Killed('before-d1-rows');
    const out = await this.d.db.batch(statements as never);
    if (hit) throw new Killed('after-d1-rows');
    return out;
  }
}

export interface Process {
  service: NonNullable<ReturnType<typeof createNativeResultsImport>>;
  token: Awaited<ReturnType<NonNullable<ReturnType<typeof createNativeResultsImport>>['admit']>>;
  stager: CandidateStager;
}
export interface ProcessOptions {
  durable: Durable; caseId: string; submissions: FinalizedSubmissionReader; stager: CandidateStager; kill?: Kill | null;
  budget?: Partial<NativeImportPorts['budget'] & object>; rowsPerBatch?: number; maxBatchFiles?: number; requestBudget?: NativeImportPorts['requestBudget'];
  operate?: boolean; staging?: boolean;
}
export const BUDGET = { maxRequestBytes: 6 << 20, maxFiles: 8192, maxFileBytes: 64 << 20, maxPackageBytes: 512 << 20 };

/** The ports of a new "process" over the durable state: fresh ledger and store, nothing remembered from a dead one. */
export function stagedPorts(o: ProcessOptions): NativeImportPorts {
  const kill = o.kill ?? null;
  const db = new ChaosD1(o.durable, kill), bucket = new ChaosR2(o.durable, kill);
  const caseRef = id('case', o.caseId) as CaseId;
  const stager = o.stager;
  const ports: NativeImportPorts = {
    clientId: CLIENT, budget: { ...BUDGET, ...o.budget }, authorizeOperate: operateAuthority(o.operate === false ? [] : [caseRef]), requestBudget: o.requestBudget ?? null,
    submissions: o.submissions, stager, packages: new StoredPackages(stager as unknown as ValidatingStager), repository: d1NativeCandidateRepository(db), audit: o.durable.audit, now: () => new Date(NOW),
    ...(o.staging === false ? {} : { staging: { ledger: d1StagingLedger(db, { rowsPerBatch: o.rowsPerBatch ?? 3 }), store: r2StagingStore(bucket), rowsPerBatch: o.rowsPerBatch ?? 3, ...(o.maxBatchFiles ? { maxBatchFiles: o.maxBatchFiles } : {}) } }),
  };
  return ports;
}

export async function startProcess(o: ProcessOptions): Promise<Process> {
  const caseRef = id('case', o.caseId) as CaseId;
  const service = createNativeResultsImport(stagedPorts(o))!;
  const token = await service.admit({ identity: who(), caseId: caseRef, access: 'write' });
  return { service, token, stager: o.stager };
}

export { sha256Hex, submissionSnapshotReader };
