// The real import, then one exact readiness GET as services.ts composes it, over one SQLite-backed D1 double.
// The renderer is a counting UNIT DOUBLE, never renderer acceptance; it is counted apart from Clerk and D1.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertV5 } from '../../../src/lib/case-package/v5/adapter.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { committedAuditRecovery } from '../../../src/lib/audit/recovery.ts';
import { caseAuthority, nativeImportPorts, WORKERS_FREE_REQUEST } from '../../../src/lib/server/runtime/hosted/import-composition.ts';
import { createNativeResultsImport } from '../../../src/lib/results-review/native/service.ts';
import { createPublicationMaterialReader } from '../../../src/lib/server/runtime/hosted/publication-material.ts';
import { hostedValidationPolicy } from '../../../src/lib/server/runtime/hosted/validation-policy.ts';
import { d1PublicationPublisher } from '../../../src/lib/publication/hosted/d1-publisher.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import { d1ReadinessFence } from '../../../src/lib/publication/hosted/readiness-fence.ts';
import { createPublicationReadiness, type PublicationReadinessPorts } from '../../../src/lib/publication/hosted/readiness.ts';
import type { NativePreviewRenderChecker } from '../../../src/lib/viewer/hosted/render-check-contract.ts';
import type { Identity, IdentityState, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { ClientResourceIdentity } from '../../../src/lib/tenancy/manifest.ts';
import { createCaseAuthorizer, d1GrantRepository } from '../../../src/lib/tenancy/index.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import type { CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { synthHtml, synthRoots } from '../../case-package/fixtures/synth.ts';
import { BUDGETS, ids } from '../storage/fixture.ts';
import { caseId, now, pdf, world } from '../native-stager/world.ts';

/** Workers Free: 50 D1 queries and 50 external subrequests per invocation; past either the platform throws. */
const PLATFORM = { d1: 50, external: 50 };
const STAFF = 'https://clerk.staff.example';

async function converted() {
  const folder = await mkdtemp(path.join(tmpdir(), 'native-readiness-')), filename = 'synthetic-client-a.pdf', bytes = pdf('alpha readiness');
  try {
    await writeFile(path.join(folder, filename), bytes);
    const roots = synthRoots();
    roots.DATA = { chronology: [{ n: '1', ref: 'JN-001', date: '2001-02-03', filename, subject: 'Invented', sender: 'Synthetic Sender', to: 'Synthetic Recipient', cc: '', excerpt: 'Invented synthetic excerpt.', doc_type: 'other', bundle: 'Original', amount: '', also_in: [], text_status: 'extracted', url: './' + filename, refs: [], invoice_no: '', size: bytes.byteLength, seq: '1', attachments: [] }] };
    roots.META = { builtAt: '2001-05-06 07:08', docCount: 1, dataFolderName: 'Synthetic', bundles: { Original: 1 }, emails: 0, invoices: 0, people: 0, textNone: 0, textPending: 0, dateSpan: ['2001-02-03', '2001-02-03'], docTypes: { other: 1 } };
    roots.SCHED = { discovery: [], supplementary: [] };
    roots.CASELINES = { file: '', pages: 0, index: [] };
    const res = await convertV5({ html: synthHtml(roots, [], {}), htmlName: 'synthetic-workspace.html', caseFolder: folder, caseId });
    if (!res.files) throw new Error('synthetic converter refused: ' + res.diagnostics.map((d) => d.code).join());
    return { files: res.files, filename, bytes };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

const worlds: ReturnType<typeof world>[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.db.sqlite.close(); });
const migration = (p: string) => readFile(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');

/** Import as one request, then compose a fresh request for readiness exactly as services.ts does. */
async function production() {
  const w = world(); worlds.push(w);
  for (const p of ['tenancy/migrations/0001_tenant_case_grants.sql', 'audit/migrations/0001_native_audit.sql', 'publication/hosted/migrations/0001_publication_ledger.sql',
    'publication/hosted/migrations/0002_atomic_publication.sql', 'publication/hosted/migrations/0003_provenance_generation.sql']) w.db.sqlite.exec(await migration(p));
  const deployment: ClientResourceIdentity = { clientId: ids.clientA, hostname: 'client-a.example', worker: 'client-a', d1DatabaseId: '11111111-1111-1111-1111-111111111111',
    d1DatabaseName: 'client-a', r2Bucket: 'client-a', clientIssuer: 'https://clerk.client-a.example', staffIssuer: STAFF };
  const config = auditConfig({ clientId: ids.clientA, trustedIssuers: [deployment.clientIssuer, STAFF], limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 10_000, maxDenialsPerActor: 1000, maxPageRows: 50, maxPagesPerRequest: 5 } });
  await provisionAuditBinding({ db: w.db, config, now });
  const grant = (gid: string, role: string, slot: string) => w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES (?, ?, 'case', ?, ?, 'synthetic-operator', 'staff', ?, ?, 'active', 1, ?, '{}', ?, 'provisioner', ?)`, gid, ids.clientA, caseId, STAFF, role, slot, `op-${gid}`, STAFF, now().toISOString());
  grant('g-operator', 'operator', 'operator'); grant('g-publisher', 'publisher', 'publisher'); grant('g-viewer', 'viewer', 'content');
  const pkg = await converted();
  const revision = await w.upload(pkg.filename, pkg.bytes);
  const rawDb = Object.assign(Object.create(w.db) as typeof w.db, { withSession: () => w.db });
  const state = { clerk: 0, revoked: false, onClerk: null as null | ((n: number) => void) };
  const requester: IdentityState = { kind: 'verified', principal: { issuer: STAFF, subject: 'synthetic-operator', kind: 'staff' }, sessionId: 'synthetic-session' as SessionId };
  /** One request's Clerk identity: every checkRevocation and every authorize is one Backend API getSession fetch. */
  function clerkIdentity(audit: ReturnType<typeof requestAuditSink>): Identity {
    const checkRevocation = async () => { state.clerk++; state.onClerk?.(state.clerk); if (state.revoked) throw contractError('invalid-session'); };
    return { ...requester, clientId: ids.clientA, checkRevocation, async authorize(scope) {
      await checkRevocation();
      // services.ts's clerk authorizeCase: a fresh explicit authorizer over the grant table and case directory.
      await createCaseAuthorizer({ deployment, grants: d1GrantRepository(w.db), cases: d1CaseDirectory({ db: w.db, deployment }), audit, now })
        .authorizeCase({ principal: requester.principal!, sessionId: requester.sessionId!, caseId: scope.caseId, operation: scope.operation });
    } };
  }
  const candidateId = await (async () => {
    const audit = requestAuditSink({ db: w.db, config, requester, now }), identity = clerkIdentity(audit);
    const ports = nativeImportPorts({ clientId: ids.clientA, identity, db: w.db, bucket: w.bucket, budgets: w.config.budgets, quotas: w.config.quotas,
      importBudget: { maxRequestBytes: 8 << 20, maxFiles: BUDGETS.maxPackageFiles, maxFileBytes: BUDGETS.maxPackageFileBytes, maxPackageBytes: BUDGETS.maxPackageBytes },
      authority: caseAuthority({ identity, deployment, db: w.db, audit, now }), audit,
      historical: committedAuditRecovery({ db: rawDb, config, now }).candidate, requestActor: requester, requestBudget: WORKERS_FREE_REQUEST, now });
    const service = createNativeResultsImport(ports)!;
    const out = await service.importPackage(await service.admit({ identity, caseId, access: 'write' }), { operationId: 'synthetic-linked', submissionRevisionId: revision, files: pkg.files });
    if (out.kind !== 'linked') throw new Error('fixture import refused: ' + JSON.stringify(out));
    return out.candidate.candidateId;
  })();
  const renders = { n: 0 };
  const renderChecker: NativePreviewRenderChecker = { async verify() { renders.n++; return { state: 'pending', rendererVersion: 'UNIT-DOUBLE-NOT-ACCEPTANCE', pages: null, reason: 'unit-double' }; } };
  /** services.ts's readiness ports for one fresh request. */
  function readiness() {
    const audit = requestAuditSink({ db: w.db, config, requester, now }), identity = clerkIdentity(audit);
    const { session, authorizer } = caseAuthority({ identity, deployment, db: w.db, audit, now });
    const material = createPublicationMaterialReader({ db: rawDb, bucket: w.bucket, clientId: ids.clientA, identity, audit, storageBudgets: w.config.budgets,
      validationLimits: hostedValidationPolicy(w.config.budgets)!, renderChecker, now })!;
    const ports: PublicationReadinessPorts = { clientId: ids.clientA, candidates: material, now,
      authorize: async (a) => { if (a.principal.kind !== 'staff' || a.capability !== 'publish') throw contractError('forbidden'); await session(a); await authorizer().authorizeCapability(a); },
      publisher: d1PublicationPublisher({ db: rawDb, clientId: ids.clientA, checkSession: async (a) => { await session(a); } }),
      ledger: d1PublicationLedger(w.db), readinessFence: d1ReadinessFence({ db: rawDb, clientId: ids.clientA }), audit };
    const url = new URL(`https://synthetic.invalid/operator/publication/${caseId}/readiness?candidateId=${candidateId}`);
    return { read: () => createPublicationReadiness(ports).read({ request: new Request(url), url, params: { caseId }, identity }) };
  }
  const revokePreview = () => w.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ? WHERE grant_id = 'g-viewer'", now().toISOString());
  return { w, state, renders, readiness, revokePreview };
}

/** Counts every D1 invocation (a batch is one) and R2 call; optionally fails past the platform's per-invocation limit. */
function meter(p: Awaited<ReturnType<typeof production>>, limit: number | null = null) {
  const n = { d1: 0, r2: 0, queries: new Map<string, number>() };
  const db = p.w.db as unknown as { prepare(sql: string): CloudD1Statement; batch(ss: CloudD1Statement[]): Promise<unknown[]> };
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const raw = new WeakMap<object, CloudD1Statement>();
  const count = (label: string) => {
    n.d1++; n.queries.set(label, (n.queries.get(label) ?? 0) + 1);
    if (limit !== null && n.d1 > limit) throw new Error('Too many API requests by single worker invocation.');
  };
  const wrap = (s: CloudD1Statement, sql: string): CloudD1Statement => {
    const w: CloudD1Statement = { bind: (...v) => wrap(s.bind(...v), sql), first: async () => { count(sql); return s.first(); }, all: async () => { count(sql); return s.all(); }, run: async () => { count(sql); return s.run(); } };
    raw.set(w, s);
    return w;
  };
  db.prepare = (sql) => wrap(prepare(sql), sql.replace(/\s+/g, ' ').slice(0, 70));
  db.batch = async (ss) => { count(`batch(${ss.length})`); return batch(ss.map((s) => raw.get(s) ?? s)); };
  const bucket = p.w.bucket as unknown as Record<'head' | 'put' | 'get', (...v: unknown[]) => Promise<unknown>>;
  for (const k of ['head', 'put', 'get'] as const) { const f = bucket[k].bind(bucket); bucket[k] = (...v) => { n.r2++; return f(...v); }; }
  return n;
}

/** This checker double has no D1 calls. Separate synthetic measurements with the real runtime budgets found warm 43 and
 * cold 45 D1 calls, including the success-receipt read; Browser and ASSETS subrequests are excluded. These are not
 * native platform measurements. A cold real render adds a receipt read, a reservation batch and a receipt batch. */
const RENDER_D1 = 3;

describe('exact readiness after one real native import on Workers Free', () => {
  it('answers 200 under the platform limit, keeping room for one cold render, not 503 readiness-unavailable', async () => {
    const p = await production();
    const n = meter(p, PLATFORM.d1), clerk = p.state.clerk;
    const response = await p.readiness().read();
    const body = await response.json();
    const cost = { d1: n.d1, external: p.state.clerk - clerk, r2: n.r2, renders: p.renders.n };
    console.log('[readiness-cost]', JSON.stringify({ status: response.status, ...cost, queries: Object.fromEntries([...n.queries].sort((a, b) => b[1] - a[1])) }));
    expect({ status: response.status, code: body.code ?? null }).toEqual({ status: 200, code: null });
    expect(body.identity.candidateId).toMatch(/^cand-/);
    expect(cost.renders).toBe(1);
    expect(cost.d1 + RENDER_D1 * cost.renders).toBeLessThanOrEqual(WORKERS_FREE_REQUEST.d1);
    expect(cost.external).toBeLessThanOrEqual(WORKERS_FREE_REQUEST.external - cost.renders);
  });

  it('answers a session or preview grant lost at any session check as its denial, never readiness or 503', async () => {
    const clean = await production(), before = clean.state.clerk;
    await clean.readiness().read();
    const total = clean.state.clerk - before;
    for (let k = 1; k <= total; k++) for (const lost of ['session', 'grant'] as const) {
      const p = await production(), start = p.state.clerk;
      p.state.onClerk = (n) => { if (n - start !== k) return; if (lost === 'session') p.state.revoked = true; else p.revokePreview(); };
      const response = await p.readiness().read();
      expect({ k, lost, status: response.status }).toEqual({ k, lost, status: lost === 'session' ? 401 : 403 });
    }
  });
});
