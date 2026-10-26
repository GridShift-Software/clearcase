// The private candidate preview's world: the production import composition (import-composition.ts) over the real
// schemas, grant table, case authorizer and request audit sink, with a Clerk-shaped identity whose session check and
// case authorization are counted. All data is invented: a v5-converted package over one uploaded PDF and one declared
// bundle that was never uploaded.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertV5 } from '../../../src/lib/case-package/v5/adapter.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { committedAuditRecovery } from '../../../src/lib/audit/recovery.ts';
import { caseAuthority, nativeImportPorts, WORKERS_FREE_REQUEST } from '../../../src/lib/server/runtime/hosted/import-composition.ts';
import { createNativeResultsImport } from '../../../src/lib/results-review/native/service.ts';
import type { CaseId, Identity, IdentityState, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { ClientResourceIdentity } from '../../../src/lib/tenancy/manifest.ts';
import type { CloudD1Statement } from '../../../src/lib/storage/cloud/bindings.ts';
import { synthHtml, synthRoots } from '../../case-package/fixtures/synth.ts';
import { BUDGETS, ids } from '../storage/fixture.ts';
import { caseId, now, pdf, world } from '../native-stager/world.ts';

export { caseId, now };
export const STAFF = 'https://clerk.staff.example';
export const CLIENT = 'https://clerk.client-a.example';
export const PRESENT = 'synthetic-client-a.pdf';
export const MISSING = 'synthetic-missing-bundle.pdf';

/** The v5 converter's package over one uploaded PDF (JN-001) and one invented bundle that is declared but absent (JN-002). */
async function converted(matter: boolean) {
  const folder = await mkdtemp(path.join(tmpdir(), 'native-preview-')), bytes = pdf('preview original');
  try {
    await writeFile(path.join(folder, PRESENT), bytes);
    const row = (n: number, filename: string, bundle: string) => ({ n: String(n), ref: `JN-00${n}`, date: `2001-02-0${n + 2}`, filename, subject: `Invented subject ${n}`, sender: 'Synthetic Sender', to: 'Synthetic Recipient', cc: '', excerpt: 'Invented synthetic excerpt.', doc_type: 'other', bundle, amount: '', also_in: [], text_status: 'extracted', url: './' + filename, refs: [], invoice_no: '', size: bytes.byteLength, seq: String(n), attachments: [] });
    const roots = synthRoots();
    roots.DATA = { ...(matter ? { matter: { title: 'Synthetic matter', short: 'S', forum: 'F', storyline: [], strategy: [] } } : {}), chronology: [row(1, PRESENT, 'Original'), row(2, MISSING, 'Invented missing bundle')] };
    roots.META = { builtAt: '2001-05-06 07:08', docCount: 2, dataFolderName: 'Synthetic', bundles: { Original: 1, 'Invented missing bundle': 1 }, emails: 0, invoices: 0, people: 0, textNone: 0, textPending: 0, dateSpan: ['2001-02-03', '2001-02-04'], docTypes: { other: 2 } };
    roots.SCHED = { discovery: [], supplementary: [] };
    roots.CASELINES = { file: '', pages: 0, index: [] };
    const res = await convertV5({ html: synthHtml(roots, [], {}), htmlName: 'synthetic-workspace.html', caseFolder: folder, caseId });
    if (!res.files) throw new Error('synthetic converter refused: ' + res.diagnostics.map((d) => d.code).join());
    return { files: res.files, bytes };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

const migration = (p: string) => readFile(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');
type Role = 'viewer' | 'editor' | 'operator' | 'publisher';

/** One deployment with a linked, durably audited current candidate, imported exactly as one production request makes it. */
/** `matter` adds the authored matter dataset a correction replaces; it is one file more than the alpha's package, so use it only uncapped. */
export async function previewWorld(o: { requestBudget?: Parameters<typeof nativeImportPorts>[0]['requestBudget']; matter?: boolean } = {}) {
  const w = world();
  for (const p of ['tenancy/migrations/0001_tenant_case_grants.sql', 'audit/migrations/0001_native_audit.sql']) w.db.sqlite.exec(await migration(p));
  const deployment: ClientResourceIdentity = { clientId: ids.clientA, hostname: 'client-a.example', worker: 'client-a', d1DatabaseId: '11111111-1111-1111-1111-111111111111',
    d1DatabaseName: 'client-a', r2Bucket: 'client-a', clientIssuer: CLIENT, staffIssuer: STAFF };
  const config = auditConfig({ clientId: ids.clientA, trustedIssuers: [CLIENT, STAFF], limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 10_000, maxDenialsPerActor: 1000, maxPageRows: 50, maxPagesPerRequest: 5 } });
  await provisionAuditBinding({ db: w.db, config, now });
  let grants = 0;
  const grant = (subject: string, role: Role, kind: Principal['kind'] = 'staff', target: string = caseId) => {
    const slot = role === 'viewer' || role === 'editor' ? 'content' : role, gid = `g-${++grants}`;
    w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
      VALUES (?, ?, 'case', ?, ?, ?, ?, ?, ?, 'active', 1, ?, '{}', ?, 'provisioner', ?)`, gid, ids.clientA, target, kind === 'staff' ? STAFF : CLIENT, subject, kind, role, slot, `op-${gid}`, STAFF, now().toISOString());
    return () => w.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ? WHERE grant_id = ?", now().toISOString(), gid);
  };
  const revokeOperate = grant('synthetic-operator', 'operator');
  const revokeContent = grant('synthetic-operator', 'viewer');
  for (const c of [ids.caseB]) { grant('synthetic-operator', 'operator', 'staff', c); grant('synthetic-operator', 'viewer', 'staff', c); }
  const pkg = await converted(o.matter === true);
  const revision = await w.upload(PRESENT, pkg.bytes);

  /** A Clerk-shaped identity: one Backend API fetch per session check, and authorize = that check, then the case authorizer. */
  const clerk = { calls: 0, revoked: false, onClerk: null as null | ((n: number) => void) };
  function identityOf(principal: Principal, sessionId = 'synthetic-session' as SessionId, clientId = ids.clientA): { identity: Identity; requester: IdentityState; audit: ReturnType<typeof requestAuditSink> } {
    const requester: IdentityState = { kind: 'verified', principal, sessionId };
    const audit = requestAuditSink({ db: w.db, config, requester, now });
    const checkRevocation = async () => { clerk.calls++; clerk.onClerk?.(clerk.calls); if (clerk.revoked) throw contractError('invalid-session'); };
    const authority = () => caseAuthority({ identity: { ...requester, clientId, checkRevocation, authorize: async () => {} } as Identity, deployment, db: w.db, audit, now });
    const identity: Identity = { ...requester, clientId, checkRevocation,
      async authorize(scope) { await checkRevocation(); await authority().authorizer().authorizeCase({ principal, sessionId, caseId: scope.caseId, operation: scope.operation }); } };
    return { identity, requester, audit };
  }
  const operator = identityOf({ issuer: STAFF, subject: 'synthetic-operator', kind: 'staff' });
  const authorityOf = (who: ReturnType<typeof identityOf>) => caseAuthority({ identity: who.identity, deployment, db: w.db, audit: who.audit, now });
  const ports = nativeImportPorts({ clientId: ids.clientA, identity: operator.identity, db: w.db, bucket: w.bucket, budgets: w.config.budgets, quotas: w.config.quotas,
    importBudget: { maxRequestBytes: 8 << 20, maxFiles: BUDGETS.maxPackageFiles, maxFileBytes: BUDGETS.maxPackageFileBytes, maxPackageBytes: BUDGETS.maxPackageBytes },
    authority: authorityOf(operator), audit: operator.audit,
    historical: committedAuditRecovery({ db: Object.assign(Object.create(w.db) as typeof w.db, { withSession: () => w.db }), config, now }).candidate,
    requestActor: operator.requester, requestBudget: o.requestBudget === undefined ? WORKERS_FREE_REQUEST : o.requestBudget, now });
  const service = createNativeResultsImport(ports)!;
  const imported = await service.importPackage(await service.admit({ identity: operator.identity, caseId, access: 'write' }), { operationId: 'synthetic-preview-import', submissionRevisionId: revision, files: pkg.files });
  if (imported.kind !== 'linked' || !imported.candidate.current) throw new Error('fixture import did not link a current candidate: ' + JSON.stringify(imported));
  const count = (sql: string) => (w.db.sqlite.prepare(sql).get() as { n: number }).n;
  const assetId = (w.db.sqlite.prepare('SELECT asset_id FROM rs_case_original WHERE case_id = ?').get(caseId) as { asset_id: string }).asset_id;
  return { w, pkg, deployment, clerk, grant, revokeOperate, revokeContent, identityOf, authorityOf, operator, service, candidate: imported.candidate, count, assetId, caseB: ids.caseB as CaseId, otherCase: id('case', 'synthetic-unknown') };
}
export type PreviewWorld = Awaited<ReturnType<typeof previewWorld>>;

/** Counts every D1 invocation (a batch is one) and R2 call, from now on. */
export function meter(p: PreviewWorld) {
  const n = { d1: 0, r2: 0 };
  const db = p.w.db as unknown as { prepare(sql: string): CloudD1Statement; batch(ss: CloudD1Statement[]): Promise<unknown[]> };
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const raw = new WeakMap<object, CloudD1Statement>();
  const wrap = (s: CloudD1Statement): CloudD1Statement => {
    const x: CloudD1Statement = { bind: (...v) => wrap(s.bind(...v)), first: () => { n.d1++; return s.first(); }, all: () => { n.d1++; return s.all(); }, run: () => { n.d1++; return s.run(); } };
    raw.set(x, s);
    return x;
  };
  db.prepare = (sql) => wrap(prepare(sql));
  db.batch = (ss) => { n.d1++; return batch(ss.map((s) => raw.get(s) ?? s)); };
  const bucket = p.w.bucket as unknown as Record<'head' | 'put' | 'get', (...v: unknown[]) => Promise<unknown>>;
  for (const k of ['head', 'put', 'get'] as const) { const f = bucket[k].bind(bucket); bucket[k] = (...v) => { n.r2++; return f(...v); }; }
  return n;
}
