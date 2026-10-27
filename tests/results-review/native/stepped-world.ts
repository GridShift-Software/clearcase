// A deployment for the stepped import: the real hosted candidate stager and validator, the real staging storage and the real native
// repositories over the node:sqlite D1 stand-in and an in-memory R2, with fault injectors that stop the "process" at a chosen write.
// Not Cloudflare. A pass here is component evidence.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { resultsVersionOf, sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { createHostedCandidateStager, type HostedCandidateStagerOptions } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import { createNativeResultsImport, d1NativeCandidateRepository, submissionSnapshotReader, type NativeD1, type NativeImportPorts } from '../../../src/lib/results-review/native/index.ts';
import { d1StagingLedger, planBatches, r2StagingStore, type StepBounds } from '../../../src/lib/results-review/native/staging/index.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { AuditEvent, CaseId, Identity, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import type { CloudD1, CloudD1Statement, CloudR2, CloudR2Body, CloudR2Head } from '../../../src/lib/storage/cloud/bindings.ts';
import { revisionIdOf } from '../../../src/lib/submissions/repository.ts';
import { BUDGETS, QUOTAS, deployment, ids, submit, submissionOp } from '../../hosted-foundation/storage/fixture.ts';
import { pocDirectory, pocPackage } from './staged-world.ts';

const MIGRATION = (name: string) => readFileSync(new URL(`../../../src/lib/results-review/native/migrations/${name}`, import.meta.url), 'utf8');
export const NOW = new Date('2001-01-01T00:00:00Z');
export const OP = 'op-stepped-0001-0b7c2f3e1d2a4c5b';
export const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

/** Budgets and quotas sized for the poc package: thousands of files, rows in batches of 100. */
export const BIG_BUDGETS = { ...BUDGETS, maxPackageFiles: 8192, maxPackageFileBytes: 64 << 20, maxPackageBytes: 512 << 20, maxDocuments: 5000, maxRowsPerBatch: 100,
  maxBufferedObjectBytes: 64 << 20, maxOriginalBytes: 64 << 20, maxVerifyObjects: 50_000, maxVerifyBytes: 1 << 30, maxVerifyObjectsPerCaseWindow: 500_000, maxVerifyBytesPerCaseWindow: 8 * (1 << 30) };
export const BIG_QUOTAS = { ...QUOTAS, maxPackageBytesPerCase: 512 << 20, maxPackageBytesPerClient: 1024 << 20, maxStagingAttemptsPerCase: 500 };
export const IMPORT_BUDGET = { maxRequestBytes: 8 << 20, maxFiles: 8192, maxFileBytes: 64 << 20, maxPackageBytes: 512 << 20 };

/** Small bounds, so the poc needs many steps and every phase is cut more than once. */
export const TEST_BOUNDS: StepBounds = Object.freeze({ originalsPerStep: 8, bytesPerStep: 512 * 1024, objectsPerStep: 40, rowsPerStep: 300, wallMsPerStep: 30_000, leaseMs: 60_000,
  structuredBytes: 32 << 20, stepsPerRequest: 1, wallMsPerRequest: 1e12 });

export interface RealPackage {
  caseId: string;
  files: Map<string, Uint8Array>;
  /** The one original the hosted intake can hold: a revision is a single file. */
  original: { path: string; bytes: Uint8Array };
  previews: number;
  documents: number;
}

/**
 * The synthetic poc package (60 documents, or CLEARCASE_POC_DOCUMENTS), reduced to what the hosted intake can carry today: every
 * document points at the one original a single-file submission holds, and each carries its own preview PDF. The datasets, the asset
 * index, the file count and the read-model rows stay at the poc's size. The asset keys of bundle files become `missing`.
 */
export async function realPackage(): Promise<RealPackage> {
  const poc = await pocPackage();
  const dir = pocDirectory();
  const idx = JSON.parse(dec(poc.files.get('assets.json')!)) as { index: string; root: string; assets: Record<string, { kind: string; path: string; sha256?: string; size?: number; mediaType: string; textStatus: string; preview?: unknown }> };
  const entries = Object.entries(idx.assets);
  const smallest = entries.filter(([k, a]) => a.kind === 'file' && !k.startsWith('P-')).sort((x, y) => x[1].size! - y[1].size!)[0]![1];
  const original = { path: 'ORIGINALS/original.pdf', bytes: new Uint8Array(readFileSync(path.join(dir, 'case', smallest.path))) };
  const sha = sha256Hex(original.bytes);
  const previews = new Map<string, Uint8Array>();
  let n = 0;
  for (const [key, a] of entries) {
    if (key.startsWith('P-')) { idx.assets[key] = { kind: 'missing', path: a.path, mediaType: a.mediaType, textStatus: a.textStatus }; continue; }
    const p = `previews/${String(n).padStart(5, '0')}.pdf`;
    const body = enc(`%PDF-1.4\n% synthetic preview ${n}\n` + (n % 50 === 0 ? 'x'.repeat(200 * 1024) : '') + '%%EOF\n');
    previews.set(p, body);
    idx.assets[key] = { kind: 'file', path: original.path, sha256: sha, size: original.bytes.byteLength, mediaType: 'application/pdf', textStatus: a.textStatus, preview: { path: p, sha256: sha256Hex(body), size: body.byteLength, originalSha256: sha } };
    n++;
  }
  const files = new Map(poc.files);
  const assets = canonicalBytes(idx);
  files.set('assets.json', assets);
  for (const [p, b] of previews) files.set(p, b);
  const manifest = JSON.parse(dec(files.get('manifest.json')!)) as { formatVersion: number; case: { id: string }; inputRevision: { id: string }; resultsVersion: string; files: { path: string; role: string; sha256: string; size: number }[] };
  manifest.files = manifest.files.map((f) => (f.path === 'assets.json' ? { ...f, sha256: sha256Hex(assets), size: assets.byteLength } : f));
  for (const [p, b] of previews) manifest.files.push({ path: p, role: 'preview', sha256: sha256Hex(b), size: b.byteLength });
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  manifest.resultsVersion = resultsVersionOf({ formatVersion: manifest.formatVersion, caseId: manifest.case.id, inputRevisionId: manifest.inputRevision.id, files: manifest.files as never });
  files.set('manifest.json', canonicalBytes(manifest));
  return { caseId: poc.caseId, files, original, previews: previews.size, documents: n };
}

/** A process that has been killed does nothing more: every later call through its bindings throws. */
export interface Life { dead: boolean }
export class Killed extends Error { readonly where: string; constructor(where: string) { super(`killed ${where}`); this.where = where; } }
export interface KillAt { op: 'put' | 'batch'; nth: number; after: boolean }

/** What survives a dead process: the database, the bucket, the audit log and the shared clock. */
export class Durable {
  readonly caseId: string;
  readonly dep: ReturnType<typeof deployment>;
  readonly events: AuditEvent[] = [];
  readonly clock = { ms: 1_000_000 };
  /** Milliseconds every bucket call takes on the shared clock: how a test makes wall time pass. */
  tick = 0;
  readonly counts = { puts: 0, batches: 0, d1: 0, gets: 0, heads: 0, deletes: 0, lists: 0, bytesRead: 0, originalGets: 0, wholeStage: 0 };
  readonly putKeys: string[] = [];
  constructor(caseId: string) {
    this.caseId = caseId;
    this.dep = deployment(ids.clientA, [caseId]);
    for (const name of ['0001_native_candidate_import.sql', '0002_native_import_staging.sql']) this.dep.db.sqlite.exec(MIGRATION(name));
  }
  get db() { return this.dep.db; }
  get bucket() { return this.dep.bucket; }
}

class ChaosR2 implements CloudR2 {
  private puts = 0;
  private readonly d: Durable;
  private readonly kill: KillAt | null;
  private readonly life: Life;
  constructor(d: Durable, kill: KillAt | null, life: Life) { this.d = d; this.kill = kill; this.life = life; }
  private alive() { if (this.life.dead) throw new Killed('dead'); }
  head(key: string): Promise<CloudR2Head | null> { this.alive(); this.d.counts.heads++; this.d.clock.ms += this.d.tick; return this.d.bucket.head(key); }
  async get(key: string): Promise<CloudR2Body | null> {
    this.alive();
    this.d.counts.gets++;
    this.d.clock.ms += this.d.tick;
    if (key.startsWith('orig/')) this.d.counts.originalGets++;
    const body = await this.d.bucket.get(key);
    return body && { ...body, arrayBuffer: async () => { const b = await body.arrayBuffer(); this.d.counts.bytesRead += b.byteLength; return b; } };
  }
  async put(key: string, value: Uint8Array, options: { sha256: string; onlyIf?: { etagDoesNotMatch: '*' } }) {
    this.alive();
    this.d.counts.puts++;
    this.d.clock.ms += this.d.tick;
    const nth = ++this.puts;
    const hit = this.kill?.op === 'put' && nth === this.kill.nth;
    if (hit && !this.kill!.after) { this.life.dead = true; throw new Killed('before-put'); }
    const out = await this.d.bucket.put(key, value, options);
    if (out) this.d.putKeys.push(key);
    if (hit) { this.life.dead = true; throw new Killed('after-put'); }
    return out;
  }
  async delete(key: string): Promise<void> { this.alive(); this.d.counts.deletes++; await this.d.bucket.delete(key); }
  list(o: { prefix: string; startAfter?: string; limit: number }) { this.alive(); this.d.counts.lists++; return this.d.bucket.list(o); }
}

class ChaosD1 implements NativeD1, CloudD1 {
  private batches = 0;
  private interleaved = false;
  private readonly sql = new WeakMap<object, string>();
  private readonly d: Durable;
  private readonly kill: KillAt | null;
  private readonly interleave: (() => Promise<void>) | null;
  private readonly life: Life;
  constructor(d: Durable, kill: KillAt | null, interleave: (() => Promise<void>) | null, life: Life) { this.d = d; this.kill = kill; this.interleave = interleave; this.life = life; }
  prepare(sql: string) {
    // bind() makes a new statement, so every statement that reaches batch() is tagged with its SQL. A D1 call is an execution or one batch.
    const tag = (s: CloudD1Statement): CloudD1Statement => {
      this.sql.set(s, sql);
      const bind = s.bind.bind(s);
      s.bind = (...v) => tag(bind(...v));
      for (const run of ['first', 'all', 'run'] as const) {
        const inner = (s[run] as () => Promise<unknown>).bind(s);
        (s as unknown as Record<string, unknown>)[run] = () => { if (this.life.dead) throw new Killed('dead'); this.d.counts.d1++; return inner(); };
      }
      return s;
    };
    return tag(this.d.db.prepare(sql)) as never;
  }
  async batch(statements: CloudD1Statement[]) {
    if (this.life.dead) throw new Killed('dead');
    // A step's commit is the batch that moves the run row; another process gets to run just before it, once.
    if (this.interleave && !this.interleaved && statements.some((s) => /UPDATE native_import_stage_run/.test(this.sql.get(s as object) ?? ''))) { this.interleaved = true; await this.interleave(); }
    this.d.counts.d1++;
    this.d.counts.batches++;
    const nth = ++this.batches;
    const hit = this.kill?.op === 'batch' && nth === this.kill.nth;
    if (hit && !this.kill!.after) { this.life.dead = true; throw new Killed('before-batch'); }
    const out = await this.d.db.batch(statements as never);
    if (hit) { this.life.dead = true; throw new Killed('after-batch'); }
    return out;
  }
}

export interface ProcessOptions { kill?: KillAt | null; bounds?: Partial<StepBounds>; operate?: boolean; interleave?: () => Promise<void>; sweepObjects?: number; requestBudget?: NativeImportPorts['requestBudget'] }
const operator = (): Identity => ({
  kind: 'verified', principal: { issuer: 'synthetic', subject: 'staff', kind: 'staff' }, sessionId: 'synthetic-session' as SessionId, clientId: ids.clientA,
  async checkRevocation() {}, async authorize() { throw new Error('client published visibility must not be used'); },
});

/** A new "process" over the durable state: fresh closures, nothing remembered from a dead one. */
export async function startProcess(d: Durable, o: ProcessOptions = {}) {
  const kill = o.kill ?? null;
  const life: Life = { dead: false };
  const db = new ChaosD1(d, kill, o.interleave ?? null, life), bucket = new ChaosR2(d, kill, life);
  const caseId = id('case', d.caseId) as CaseId;
  const identity = operator();
  const audit: HostedCandidateStagerOptions['audit'] = { async append(e) { d.events.push(e); return { eventId: e.eventId }; } };
  const authorizeOperate: HostedCandidateStagerOptions['authorizeOperate'] = async (a) => { if (o.operate === false || a.caseId !== caseId) throw contractError('forbidden'); };
  const operateCondition: HostedCandidateStagerOptions['operateCondition'] = () => ({ sql: '? = 1', values: [o.operate === false ? 0 : 1] });
  const bounds = { ...TEST_BOUNDS, ...o.bounds };
  const config: HostedCandidateStagerOptions = { bindings: { db, bucket }, clientId: ids.clientA, budgets: BIG_BUDGETS, quotas: BIG_QUOTAS, identity, authorizeOperate, operateCondition, audit, now: () => NOW,
    steps: { bounds, clock: () => d.clock.ms, leaseId: () => crypto.randomUUID() } };
  const stager = createHostedCandidateStager(config);
  const whole = { stage: (a: Parameters<typeof stager.stager.stage>[0]) => { d.counts.wholeStage++; return stager.stager.stage(a); } };
  const service = createNativeResultsImport({ ...stager, stager: whole, clientId: ids.clientA, budget: IMPORT_BUDGET, authorizeOperate, observeOperate: authorizeOperate, operateCondition, submissions: submissionSnapshotReader(db), repository: d1NativeCandidateRepository(db),
    audit, now: () => NOW, requestBudget: o.requestBudget ?? null,
    staging: { ledger: d1StagingLedger(db, { rowsPerBatch: BIG_BUDGETS.maxRowsPerBatch }), store: r2StagingStore(bucket, { maxBytes: IMPORT_BUDGET.maxFileBytes }), rowsPerBatch: BIG_BUDGETS.maxRowsPerBatch, ...(o.sweepObjects ? { sweepObjects: o.sweepObjects } : {}) } })!;
  const token = await service.admit({ identity, caseId, access: 'write' });
  return { service, token, staged: service.staged!, bounds, packages: stager.packages };
}
export type Process = Awaited<ReturnType<typeof startProcess>>;

/** The deployment with the package's one original uploaded through the real client intake, and the revision it finalized. */
export async function uploaded(pkg: RealPackage): Promise<{ durable: Durable; revisionId: string }> {
  const durable = new Durable(pkg.caseId);
  await submit(durable.dep, pkg.caseId, [{ path: pkg.original.path, bytes: pkg.original.bytes, ref: 'selected' }]);
  return { durable, revisionId: revisionIdOf(submissionOp(pkg.caseId, 'selected')) };
}

/** The one-request import, as it stands, of the whole package. */
export async function importWhole(p: Process, pkg: RealPackage, revisionId: string) {
  return p.service.importPackage(p.token, { operationId: OP, submissionRevisionId: revisionId, files: pkg.files });
}

export interface StepRecord { phase: string; ms: number; originalGets: number; d1: number; r2Gets: number; bytesRead: number; puts: number; heads: number }
/** What a client does: open with the manifest, send every file in planned batches, then call complete until it answers. */
export async function driveStaged(p: Process, d: Durable, pkg: RealPackage, revisionId: string, o: { steps?: StepRecord[]; maxCalls?: number; mark?: { puts: number; batches: number } } = {}) {
  const manifest = pkg.files.get('manifest.json')!;
  const opened = await p.staged.open(p.token, { operationId: OP, submissionRevisionId: revisionId, manifest });
  if (opened.kind !== 'progress') throw new Error('open refused ' + JSON.stringify(opened));
  for (;;) {
    const s = await p.staged.status(p.token, { operationId: OP });
    if (s.kind !== 'progress') throw new Error('status refused ' + JSON.stringify(s));
    if (s.missing.length === 0) break;
    const sizes = s.missing.map((m) => [m, pkg.files.get(m)!.byteLength] as const);
    for (const batch of planBatches(sizes, p.staged.bounds)) {
      const out = await p.staged.put(p.token, { operationId: OP, files: new Map(batch.map((m) => [m, pkg.files.get(m)!] as const)) });
      if (out.kind !== 'progress') throw new Error('put refused ' + JSON.stringify(out));
    }
  }
  if (o.mark) { o.mark.puts = d.counts.puts; o.mark.batches = d.counts.batches; }
  return completeAll(p, d, o);
}

/** Calls complete until it stops saying it is staging. */
export async function completeAll(p: Process, d: Durable, o: { steps?: StepRecord[]; maxCalls?: number } = {}) {
  for (let calls = 0; calls < (o.maxCalls ?? 5000); calls++) {
    const before = { ...d.counts }, startMs = d.clock.ms;
    const out = await p.staged.complete(p.token, { operationId: OP });
    if (o.steps) o.steps.push({ phase: out.kind === 'staging' ? out.phase : out.kind, ms: d.clock.ms - startMs, originalGets: d.counts.originalGets - before.originalGets, d1: d.counts.d1 - before.d1, r2Gets: d.counts.gets - before.gets, bytesRead: d.counts.bytesRead - before.bytesRead, puts: d.counts.puts - before.puts, heads: d.counts.heads - before.heads });
    if (out.kind !== 'staging') return out;
  }
  throw new Error('complete never finished');
}

export function resultsVersionOfPackage(pkg: RealPackage) { return resultsVersion(JSON.parse(dec(pkg.files.get('manifest.json')!)).resultsVersion); }

/** Every row a candidate leaves, ordered, plus the package objects: what must be identical between the two imports. */
export function dump(d: Durable) {
  const tables = ['rs_results_version', 'rs_package_file', 'rs_document', 'rs_asset', 'rs_seed', 'rs_preview', 'native_import_attempt', 'native_candidate', 'native_import_link', 'native_candidate_supersession'];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const cols = (d.db.rows(`PRAGMA table_info(${t})`) as { name: string }[]).map((c) => c.name);
    out[t] = d.db.rows(`SELECT * FROM ${t} ORDER BY ${cols.map((c) => `"${c}"`).join(', ')}`);
  }
  out.objects = [...d.bucket.objects.keys()].filter((k) => k.startsWith('pkg/') || k.startsWith('orig/')).sort().map((k) => [k, sha256Hex(d.bucket.objects.get(k)!.bytes)]);
  return out;
}
export const rowsOf = (d: Durable, sql: string) => d.db.rows(sql);

