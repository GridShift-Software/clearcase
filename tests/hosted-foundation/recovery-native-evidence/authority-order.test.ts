// Recheck P1/P3: real recovery controllers/adapters/authorizer/audit; synthetic SQLite and streamed R2 transports.
import { afterEach, expect, it } from 'vitest';
import { exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { applyNativeRestore, planNativeRestore } from '../../../src/lib/recovery/hosted/restore.ts';
import { publicAuditReader, requestAuditSink, type AuditReadGate } from '../../../src/lib/audit/index.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { Identity, IdentityState } from '../../../src/lib/server/runtime/contracts.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { world, CASE, CLIENT, now, type World } from '../recovery-native-adapters/world.ts';
import { nativeWorld, POLICY, req, AUDIT_GATE } from './world.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
async function source() { const w = await nativeWorld(); worlds.push(w); return w; }
const noAudit = { maxLineageRows: POLICY.maxLineageRows, maxLineageBytes: POLICY.maxLineageBytes };
function contentOnly(w: World) {
  const requester: IdentityState = { kind: 'verified', principal: { issuer: 'https://clerk.client-a.example', subject: 'probe-content-only', kind: 'client' }, sessionId: id('session', 'probe-content-token') };
  const { principal, sessionId } = requester;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at)
    VALUES ('probe-content',?,'case',?,?,?,'client','editor','content','active',1,'probe-op','{}','https://clerk.staff.example','provisioner',?)`, CLIENT, CASE, principal.issuer, principal.subject, now().toISOString());
  const audit = requestAuditSink({ db: w.db, config: w.auditConfig, requester, now });
  const deployment = w.options.resources.deployment;
  const authorizer = createCaseAuthorizer({ deployment, grants: d1GrantRepository(w.db), cases: d1CaseDirectory({ db: w.db, deployment }), audit, now });
  const identity: Identity = { ...requester, clientId: CLIENT, async checkRevocation() {}, async authorize(q) { await authorizer.authorizeCase({ ...q, principal, sessionId }); } };
  w.options.identity = identity; w.options.audit = audit;
  return { identity, requester };
}
it('P1: actual content-only export gates before any native_audit_events statement, like the public reader', async () => {
  const w = await source(), { identity: who, requester } = contentOnly(w), reads: string[] = [];
  const prepare = w.db.prepare.bind(w.db);
  w.db.prepare = (sql) => { if (/\bSELECT\b/i.test(sql) && /\bnative_audit_events\b/.test(sql)) reads.push(sql); return prepare(sql); };
  w.options.nativeEvidence = { ...noAudit };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'recovery-unavailable' });
  expect(reads).toEqual([]);
  let checks = 0;
  const gate: AuditReadGate = { async caseAudit(a) { checks++; expect(a).toEqual({ principal: who.principal, sessionId: who.sessionId, caseId: CASE }); throw contractError('forbidden'); }, async administrationAudit() { throw contractError('forbidden'); } };
  const reader = publicAuditReader({ db: w.db, config: w.auditConfig, requester, gate, now });
  await expect(reader.query({ scope: { kind: 'case', caseId: CASE }, cursor: null, limit: 50 })).rejects.toMatchObject({ code: 'forbidden' });
  expect(reads).toEqual([]);
  w.options.nativeEvidence = { ...noAudit, audit: gate };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'forbidden' });
  expect(checks).toBe(2);
  expect(w.bucket.puts.filter((k) => k.includes('/native-e1/'))).toEqual([]);
  expect(reads, 'case-audit denial must precede the first protected audit SELECT').toEqual([]);
});
it('P3: receiving session revoked during source caseAudit after target head prevents every put; entitled retry succeeds', async () => {
  const s = await source(), t = await world(true, true, true); worlds.push(t); s.options.target = t.options;
  let armed = false, tripped = false;
  s.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); if (armed) { armed = false; tripped = true; t.state.revoked = true; } } };
  const d = await s.deps(), out = await exportNativeCase(d, req), r = { ...req, expectedManifestSha256: out.manifestSha256 };
  const plan = await planNativeRestore(d, r), head = t.bucket.head.bind(t.bucket);
  t.bucket.head = async (key) => { const result = await head(key); if (key.includes('/blobs/')) armed = true; return result; };
  await expect(applyNativeRestore(d, { ...r, confirmedPlanSha256: plan.planSha256, operationId: 'probe-target-race' })).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(tripped).toBe(true);
  const deniedWrites = [...t.bucket.puts];
  t.state.revoked = false; t.bucket.head = head;
  const retryPlan = await planNativeRestore(d, r), result = await applyNativeRestore(d, { ...r, confirmedPlanSha256: retryPlan.planSha256, operationId: 'probe-target-retry' });
  expect(result).toMatchObject({ ok: true, activated: false });
  expect(t.bucket.puts.length).toBeGreaterThan(0);
  for (const table of ['rs_publication', 'native_candidate', 'rs_case_original', 'submissions_revision']) expect(t.db.rows(`SELECT * FROM ${table}`)).toEqual([]);
  expect(deniedWrites, 'receiving authority revoked during source audit IO must prevent R2 put').toEqual([]);
});
