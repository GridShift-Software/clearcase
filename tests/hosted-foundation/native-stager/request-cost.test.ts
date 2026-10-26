import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertV5 } from '../../../src/lib/case-package/v5/adapter.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { committedAuditRecovery } from '../../../src/lib/audit/recovery.ts';
import { caseAuthority, nativeImportPorts, WORKERS_FREE_REQUEST } from '../../../src/lib/server/runtime/hosted/import-composition.ts';
import { nativeImportCost } from '../../../src/lib/results-review/native/budget.ts';
import { createNativeResultsImport } from '../../../src/lib/results-review/native/service.ts';
import type { Identity, IdentityState, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { ClientResourceIdentity } from '../../../src/lib/tenancy/manifest.ts';
import type { CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { synthHtml, synthRoots } from '../../case-package/fixtures/synth.ts';
import { BUDGETS } from '../storage/fixture.ts';
import { ids } from '../storage/fixture.ts';
import { caseId, now, pdf, world } from './world.ts';
import { d1, digest, trace } from '../preview/trace.ts';

/** Workers Free allows 50 external subrequests and 50 D1 queries per invocation; five of each are kept as headroom. */
const FREE = { external: 45, d1: 45, cloudflare: 1000 };
const STAFF = 'https://clerk.staff.example';

/** The alpha's real shape: the v5 converter's package (nine files) over one invented PDF original, indexed by `docs` documents. */
async function converted(docs = 1) {
  const folder = await mkdtemp(path.join(tmpdir(), 'native-cost-')), filename = 'synthetic-client-a.pdf', bytes = pdf('alpha cost');
  try {
    await writeFile(path.join(folder, filename), bytes);
    const roots = synthRoots();
    roots.DATA = { chronology: Array.from({ length: docs }, (_, i) => ({ n: String(i + 1), ref: `JN-00${i + 1}`, date: '2001-02-03', filename, subject: 'Invented', sender: 'Synthetic Sender', to: 'Synthetic Recipient', cc: '', excerpt: 'Invented synthetic excerpt.', doc_type: 'other', bundle: 'Original', amount: '', also_in: [], text_status: 'extracted', url: './' + filename, refs: [], invoice_no: '', size: bytes.byteLength, seq: String(i + 1), attachments: [] })) };
    roots.META = { builtAt: '2001-05-06 07:08', docCount: docs, dataFolderName: 'Synthetic', bundles: { Original: docs }, emails: 0, invoices: 0, people: 0, textNone: 0, textPending: 0, dateSpan: ['2001-02-03', '2001-02-03'], docTypes: { other: docs } };
    roots.SCHED = { discovery: [], supplementary: [] };
    roots.CASELINES = { file: '', pages: 0, index: [] };
    const res = await convertV5({ html: synthHtml(roots, [], {}), htmlName: 'synthetic-workspace.html', caseFolder: folder, caseId });
    if (!res.files) throw new Error('synthetic converter refused: ' + res.diagnostics.map((d) => d.code).join());
    return { files: res.files, filename, bytes };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

const worlds: ReturnType<typeof world>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const w of worlds.splice(0)) w.db.sqlite.close(); });
const migration = (p: string) => readFile(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');

/**
 * The import as production composes it (import-composition.ts): a Clerk session check per `checkRevocation`, the explicit
 * grant authorizer over the real grant table and case directory, and the real request audit sink, all over one database.
 */
async function production(o: { docs?: number; requestBudget?: Parameters<typeof nativeImportPorts>[0]['requestBudget'] } = {}) {
  const w = world(); worlds.push(w);
  for (const p of ['tenancy/migrations/0001_tenant_case_grants.sql', 'audit/migrations/0001_native_audit.sql']) w.db.sqlite.exec(await migration(p));
  const deployment: ClientResourceIdentity = { clientId: ids.clientA, hostname: 'client-a.example', worker: 'client-a', d1DatabaseId: '11111111-1111-1111-1111-111111111111',
    d1DatabaseName: 'client-a', r2Bucket: 'client-a', clientIssuer: 'https://clerk.client-a.example', staffIssuer: STAFF };
  const config = auditConfig({ clientId: ids.clientA, trustedIssuers: [deployment.clientIssuer, STAFF], limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 10_000, maxDenialsPerActor: 1000, maxPageRows: 50, maxPagesPerRequest: 5 } });
  await provisionAuditBinding({ db: w.db, config, now });
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES ('g-operator', ?, 'case', ?, ?, 'synthetic-operator', 'staff', 'operator', 'operator', 'active', 1, 'grant-op', '{}', ?, 'provisioner', ?)`, ids.clientA, caseId, STAFF, STAFF, now().toISOString());
  const pkg = await converted(o.docs);
  const revision = await w.upload(pkg.filename, pkg.bytes);
  const state = { revoked: false, clerk: 0, onClerk: null as null | ((n: number) => void) };
  const requester: IdentityState = { kind: 'verified', principal: { issuer: STAFF, subject: 'synthetic-operator', kind: 'staff' }, sessionId: 'synthetic-session' as SessionId };
  const identity: Identity = { ...requester, clientId: ids.clientA,
    // One Clerk Backend API getSession fetch in production.
    async checkRevocation() { state.clerk++; state.onClerk?.(state.clerk); if (state.revoked) throw contractError('invalid-session'); },
    async authorize() { throw new Error('client published visibility must not be used'); },
  };
  const audit = requestAuditSink({ db: w.db, config, requester, now });
  const rawDb = Object.assign(Object.create(w.db) as typeof w.db, { withSession: () => w.db });
  const ports = nativeImportPorts({ clientId: ids.clientA, identity, db: w.db, bucket: w.bucket, budgets: w.config.budgets, quotas: w.config.quotas,
    importBudget: { maxRequestBytes: 8 << 20, maxFiles: BUDGETS.maxPackageFiles, maxFileBytes: BUDGETS.maxPackageFileBytes, maxPackageBytes: BUDGETS.maxPackageBytes },
    authority: caseAuthority({ identity, deployment, db: w.db, audit, now }), audit,
    historical: committedAuditRecovery({ db: rawDb, config, now }).candidate, requestActor: requester, requestBudget: o.requestBudget === undefined ? WORKERS_FREE_REQUEST : o.requestBudget, now });
  const service = createNativeResultsImport(ports)!;
  /** One import request as the controller makes it: admit, then import. */
  const request = async (operationId = 'synthetic-linked') => service.importPackage(await service.admit({ identity, caseId, access: 'write' }), { operationId, submissionRevisionId: revision, files: pkg.files });
  const count = (sql: string) => (w.db.sqlite.prepare(sql).get() as { n: number }).n;
  return { w, pkg, state, request, count, revokeGrant: () => w.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ? WHERE grant_id = 'g-operator'", now().toISOString()) };
}
type Production = Awaited<ReturnType<typeof production>>;

/** The package's shape as the cost model reads it, with the read-model rows the stored version expects. */
function shape(p: Production) {
  const v = p.w.db.sqlite.prepare('SELECT expected_documents + expected_assets + expected_seeds AS rows FROM rs_results_version').get() as { rows: number };
  return { files: p.pkg.files.size, originals: 1, rows: v.rows };
}
/** Nothing published, and no settled audit without its delivered event (no acknowledgement the audit log never gave). */
function noFalseRecord(p: Production) {
  expect(p.count('SELECT COUNT(*) AS n FROM rs_publication')).toBe(0);
  expect(p.count(`SELECT COUNT(*) AS n FROM native_candidate_audit_settlement s
    WHERE NOT EXISTS (SELECT 1 FROM native_audit_events e WHERE e.event_id = s.event_id)`)).toBe(0);
}

/** Counts every D1 invocation (a batch is one) and R2 call one import makes, with the query that made each. */
function meter(p: Production) {
  const n = { d1: 0, r2: 0, queries: new Map<string, number>() };
  const db = p.w.db as unknown as { prepare(sql: string): CloudD1Statement; batch(ss: CloudD1Statement[]): Promise<unknown[]> };
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const raw = new WeakMap<object, CloudD1Statement>();
  const count = (label: string) => { n.d1++; n.queries.set(label, (n.queries.get(label) ?? 0) + 1); };
  const wrap = (s: CloudD1Statement, sql: string): CloudD1Statement => {
    const w: CloudD1Statement = { bind: (...v) => wrap(s.bind(...v), sql), first: () => { count(sql); return s.first(); }, all: () => { count(sql); return s.all(); }, run: () => { count(sql); return s.run(); } };
    raw.set(w, s);
    return w;
  };
  db.prepare = (sql) => wrap(prepare(sql), sql.replace(/\s+/g, ' ').slice(0, 70));
  db.batch = (ss) => { count(`batch(${ss.length})`); return batch(ss.map((s) => raw.get(s) ?? s)); };
  const bucket = p.w.bucket as unknown as Record<'head' | 'put' | 'get', (...v: unknown[]) => Promise<unknown>>;
  for (const k of ['head', 'put', 'get'] as const) { const f = bucket[k].bind(bucket); bucket[k] = (...v) => { n.r2++; return f(...v); }; }
  return n;
}

describe('one native import request on Workers Free', () => {
  it('links the alpha package within 45 Clerk fetches and 45 D1 calls, admission and final audit included', async () => {
    const p = await production(), n = meter(p);
    const out = await p.request();
    const cost = { external: p.state.clerk, d1: n.d1, cloudflare: n.d1 + n.r2 };
    console.log('[cost]', JSON.stringify({ ...cost, r2: n.r2, queries: Object.fromEntries([...n.queries].sort((a, b) => b[1] - a[1])) }));
    expect(out.kind).toBe('linked');
    expect(cost).toEqual({ external: expect.toSatisfy((x: number) => x <= FREE.external), d1: expect.toSatisfy((x: number) => x <= FREE.d1), cloudflare: expect.toSatisfy((x: number) => x <= FREE.cloudflare) });
    expect({ d1: cost.d1, external: cost.external }).toEqual(nativeImportCost(shape(p), BUDGETS.maxRowsPerBatch));
    // The alpha package at the runtime's rows per batch: the release fence is one D1 call after the settlement readback.
    expect({ d1: cost.d1, external: cost.external }).toEqual({ d1: 44, external: 18 });
    noFalseRecord(p);
  });

  it('costs what the model says as the package grows, so the budget refusal is honest', async () => {
    for (const docs of [3, 8]) {
      const p = await production({ docs, requestBudget: null }), n = meter(p);
      expect((await p.request()).kind).toBe('linked');
      console.log('[cost]', JSON.stringify({ docs, external: p.state.clerk, d1: n.d1, shape: shape(p) }));
      expect({ d1: n.d1, external: p.state.clerk }).toEqual(nativeImportCost(shape(p), BUDGETS.maxRowsPerBatch));
    }
  });

  it('refuses work over one request in the stager, before its first write, with the counts it needs', async () => {
    const p = await production({ docs: 8 }), n = meter(p);
    const out = await p.request();
    expect(out).toEqual({ kind: 'refused', code: 'over-budget', detail: ['this import needs 49 D1 calls and 23 subrequests; one request here may make 45 and 45'] });
    expect(p.count('SELECT COUNT(*) AS n FROM native_import_attempt')).toBe(1);
    expect(p.count('SELECT COUNT(*) AS n FROM rs_results_version')).toBe(0);
    expect(p.count('SELECT COUNT(*) AS n FROM rs_verification_work')).toBe(0);
    expect([...p.w.bucket.objects.keys()].filter((k) => k.startsWith('pkg/'))).toEqual([]);
    expect(n.d1).toBeLessThanOrEqual(FREE.d1);
    noFalseRecord(p);
  });

  it('refuses work its package already shows is over the limit before the attempt is recorded', async () => {
    // The lower bound with no rows is 43 here: a limit of 42 refuses in the service, before anything is written.
    const p = await production({ requestBudget: { d1: 42, external: 45 } });
    expect(await p.request()).toEqual({ kind: 'refused', code: 'over-budget', detail: ['this import needs 43 D1 calls and 17 subrequests; one request here may make 42 and 45'] });
    expect(p.count('SELECT COUNT(*) AS n FROM native_import_attempt')).toBe(0);
    expect(p.count('SELECT COUNT(*) AS n FROM rs_results_version')).toBe(0);
    noFalseRecord(p);
  });

  const total = 18;
  it('makes the measured number of session checks', async () => {
    const p = await production();
    await p.request();
    expect(p.state.clerk).toBe(total);
  });
  it.each(Array.from({ length: total }, (_, i) => i + 1).flatMap((k) => [['session', k], ['grant', k]] as const))('answers a %s revoked at session check %i as its denial, never a link', async (lost, k) => {
    const p = await production();
    p.state.onClerk = (n) => { if (n !== k) return; if (lost === 'session') p.state.revoked = true; else p.revokeGrant(); };
    await expect(p.request()).rejects.toMatchObject({ code: lost === 'session' ? 'invalid-session' : 'forbidden' });
    noFalseRecord(p);
  });

  it('keeps a candidate noncurrent when its audit fails, and the same operation then links it once', async () => {
    const p = await production();
    const prepare = p.w.db.prepare.bind(p.w.db);
    let fail = true;
    p.w.db.prepare = (sql) => {
      const s = prepare(sql);
      if (!/^INSERT INTO native_audit_events/.test(sql)) return s;
      return { ...s, bind: (...v: unknown[]) => {
        const b = s.bind(...(v as never[]));
        return fail && v.some((x) => typeof x === 'string' && x.includes('"results.import-candidate"')) ? { ...b, run: async () => { throw new Error('synthetic audit fault'); }, first: async () => { throw new Error('synthetic audit fault'); }, all: async () => { throw new Error('synthetic audit fault'); } } : b;
      } } as typeof s;
    };
    await expect(p.request()).rejects.toThrow();
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate')).toBe(1);
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate_audit_settlement')).toBe(0);
    noFalseRecord(p);
    fail = false;
    const before = p.state.clerk;
    const again = await p.request();
    expect(again).toMatchObject({ kind: 'linked', repeated: true, candidate: { current: true } });
    expect(p.state.clerk - before).toBeLessThanOrEqual(FREE.external);
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate')).toBe(1);
    expect(await p.request()).toMatchObject({ kind: 'linked', repeated: true, candidate: { current: true } });
    noFalseRecord(p);
  });

  it('refuses an original whose bytes changed at rest, with nothing staged', async () => {
    const p = await production();
    const key = [...p.w.bucket.objects.keys()].find((k) => k.startsWith('orig/'))!;
    p.w.bucket.tamper(key, (b) => { b[b.length - 1] ^= 1; return b; });
    expect(await p.request()).toMatchObject({ kind: 'refused', code: 'validator-refused', detail: ['integrity', 'selected original is missing or changed'] });
    expect(p.count('SELECT COUNT(*) AS n FROM rs_results_version')).toBe(0);
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate')).toBe(0);
    noFalseRecord(p);
  });

  it.each([['grant', 'forbidden'], ['session', 'invalid-session']] as const)('answers a %s lost at the first hash after the settlement as its denial, never a fresh link', async (lost, code) => {
    const p = await production();
    const t = trace(p.w.db);
    t.when([d1('INSERT INTO native_candidate_audit_settlement'), digest], () => { if (lost === 'session') p.state.revoked = true; else p.revokeGrant(); });
    await expect(p.request()).rejects.toMatchObject({ code });
    noFalseRecord(p);
  });
});
