// Ordering controls at real native adapter IO seams; not Clerk/D1/R2 acceptance.
import { afterEach, expect, it } from 'vitest';
import { exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { verifyNativeExport } from '../../../src/lib/recovery/hosted/native-evidence.ts';
import { applyNativeRestore, planNativeRestore } from '../../../src/lib/recovery/hosted/restore.ts';
import { sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { world, CASE, CLIENT, enc, type World } from '../recovery-native-adapters/world.ts';
import { nativeWorld, req, AUDIT_GATE } from './world.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
async function source() { const w = await nativeWorld(); worlds.push(w); return w; }
async function pair() { const s = await source(), t = await world(true, true, true); worlds.push(t); s.options.target = t.options; return { s, t }; }
it('capture itself requires caseAudit before preparing protected history and still succeeds when entitled', async () => {
  const s = await source(); let deny = true, protectedStatements = 0;
  s.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); if (deny) throw contractError('forbidden'); } };
  const d = await s.deps(), prepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql) => { if (sql.includes('FROM native_audit_events') && !sql.includes('event_id = ?')) protectedStatements++; return prepare(sql); };
  await expect(d.nativeEvidence!.capture({ audit: 'case-audit/1' })).rejects.toMatchObject({ code: 'forbidden' });
  expect(protectedStatements).toBe(0);
  deny = false;
  expect((await d.nativeEvidence!.capture({ audit: 'case-audit/1' })).evidence.tables.native_audit_events!.length).toBeGreaterThan(0);
  expect(protectedStatements).toBeGreaterThan(0);
});
it.each(['verify', 'plan', 'apply'] as const)('%s gates even an existing private manifest before the first R2 read', async (action) => {
  const { s, t } = await pair(); let deny = false;
  s.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); if (deny) throw contractError('forbidden'); } };
  const d = await s.deps(), out = await exportNativeCase(d, req), r = { ...req, expectedManifestSha256: out.manifestSha256 }, p = await planNativeRestore(d, r);
  const reads = s.bucket.reads.length; deny = true;
  const run = () => action === 'verify' ? verifyNativeExport(d, r) : action === 'plan' ? planNativeRestore(d, r) : applyNativeRestore(d, { ...r, confirmedPlanSha256: p.planSha256, operationId: 'denied-before-manifest' });
  await expect(run()).rejects.toMatchObject({ code: 'forbidden' });
  expect(s.bucket.reads.length).toBe(reads);
  expect(t.bucket.puts).toEqual([]); expect(t.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
  deny = false; await expect(verifyNativeExport(d, r)).resolves.toMatchObject({ manifestSha256: out.manifestSha256 });
});
it.each(['session', 'grant'] as const)('target private reads observe %s revocation during the source audit callback before R2 get', async (kind) => {
  const { s, t } = await pair(), d = await s.deps();
  const bytes = enc('private target'), sha256 = await sha256Hex(bytes), key = `restore/${CLIENT}/${CASE}/order/blobs/${sha256}`;
  await d.target!.objects.putIfAbsent({ key, bytes, sha256 });
  const reads = t.bucket.reads.length;
  await expect(d.target!.objects.get(key, { async beforeRead() { await d.nativeEvidence!.audit!.requireCaseAudit({ identity: d.identity, caseId: CASE }); if (kind === 'session') t.state.revoked = true; else t.revokeGrant(); } })).rejects.toMatchObject({ code: kind === 'session' ? 'invalid-session' : 'forbidden' });
  expect(t.bucket.reads.length).toBe(reads);
});
it.each(['blob', 'seal'] as const)('target %s checks receiving grants after awaited source audit at the actual put boundary', async (what) => {
  const { s, t } = await pair(), d = await s.deps(), bytes = enc('immutable'), sha256 = await sha256Hex(bytes);
  const key = `restore/${CLIENT}/${CASE}/order/${what === 'blob' ? `blobs/${sha256}` : 'manifest.json'}`, head = t.bucket.head.bind(t.bucket);
  let armed = false, checked = false;
  t.bucket.head = async (k) => { const r = await head(k); if (k === key) armed = true; return r; };
  await expect(d.target!.objects.putIfAbsent({ key, bytes, sha256, async beforeCommit() { await d.nativeEvidence!.audit!.requireCaseAudit({ identity: d.identity, caseId: CASE }); if (armed) { checked = true; t.revokeGrant(); } } })).rejects.toMatchObject({ code: 'forbidden' });
  expect(checked).toBe(true); expect(t.bucket.puts).toEqual([]); expect(t.bucket.objects.has(key)).toBe(false);
});
it.each(['snapshot', 'import'] as const)('target %s repeats source audit then receiving authority at the D1 mutation, after internal preflight', async (what) => {
  const { s, t } = await pair(), d = await s.deps(), target = d.target!, snapshot = await target.userWork.exportAll({ caseId: CASE }), revision = await target.stateRevision();
  const preRestore = what === 'import' ? await target.userWork.snapshots.put({ caseId: CASE, snapshot, revision }) : null;
  const prepare = t.db.prepare.bind(t.db); let armed = false, tripped = false;
  t.db.prepare = (sql) => { if (sql.includes(what === 'snapshot' ? 'INSERT INTO uw_snapshot' : 'INSERT INTO uw_operation')) armed = true; return prepare(sql); };
  const beforeCommit = async () => { await d.nativeEvidence!.audit!.requireCaseAudit({ identity: d.identity, caseId: CASE }); if (armed) { tripped = true; t.state.revoked = true; } };
  const run = () => what === 'snapshot' ? target.userWork.snapshots.put({ caseId: CASE, snapshot, revision, beforeCommit }) : target.userWork.importAll({ caseId: CASE, snapshot, expectedRevision: revision, operationId: 'order-import', preRestore: preRestore!, beforeCommit });
  await expect(run()).rejects.toMatchObject({ code: expect.stringMatching(/invalid-session|storage-unavailable/) });
  expect(tripped).toBe(true); expect(t.db.rows('SELECT * FROM uw_operation')).toEqual([]);
  expect(t.db.rows('SELECT * FROM uw_snapshot')).toHaveLength(what === 'import' ? 1 : 0);
  expect(t.bucket.puts).toEqual([]);
});
it('receiving grant revocation inside source caseAudit after target head prevents every new object', async () => {
  const { s, t } = await pair(); let armed = false, tripped = false;
  s.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); if (armed) { armed = false; tripped = true; t.revokeGrant(); } } };
  const d = await s.deps(), out = await exportNativeCase(d, req), r = { ...req, expectedManifestSha256: out.manifestSha256 }, plan = await planNativeRestore(d, r), head = t.bucket.head.bind(t.bucket);
  t.bucket.head = async (key) => { const result = await head(key); if (key.includes('/blobs/')) armed = true; return result; };
  await expect(applyNativeRestore(d, { ...r, confirmedPlanSha256: plan.planSha256, operationId: 'grant-during-source-audit' })).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(tripped).toBe(true); expect(t.bucket.puts).toEqual([]); expect(t.db.rows('SELECT * FROM uw_operation')).toEqual([]);
});
it.each(['snapshot', 'import'] as const)('apply forwards live source audit through the target %s internal preflight', async (what) => {
  const { s, t } = await pair(); let armed = false, tripped = false;
  s.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); if (armed) { tripped = true; t.revokeGrant(); } } };
  const d = await s.deps(), out = await exportNativeCase(d, req), r = { ...req, expectedManifestSha256: out.manifestSha256 }, p = await planNativeRestore(d, r), prepare = t.db.prepare.bind(t.db);
  t.db.prepare = (sql) => { if (sql.includes(what === 'snapshot' ? 'INSERT INTO uw_snapshot' : 'INSERT INTO uw_operation')) armed = true; return prepare(sql); };
  await expect(applyNativeRestore(d, { ...r, confirmedPlanSha256: p.planSha256, operationId: `apply-${what}-order` })).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|storage-unavailable/) });
  expect(tripped).toBe(true); expect(t.db.rows('SELECT * FROM uw_operation')).toEqual([]);
  expect(t.db.rows('SELECT * FROM uw_snapshot')).toHaveLength(what === 'import' ? 1 : 0);
  if (what === 'snapshot') expect(t.bucket.puts).toEqual([]);
  for (const table of ['rs_publication', 'native_candidate', 'rs_case_original', 'submissions_revision']) expect(t.db.rows(`SELECT * FROM ${table}`)).toEqual([]);
});
it('revocation during manifest metadata prevents even the first body pull', async () => {
  const s = await source(); let deny = false;
  s.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); if (deny) throw contractError('forbidden'); } };
  const d = await s.deps(), out = await exportNativeCase(d, req), pulls = s.bucket.bodyReads;
  s.bucket.afterGet = (key) => { if (key === out.manifestKey) deny = true; };
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: out.manifestSha256 })).rejects.toMatchObject({ code: 'forbidden' });
  expect(s.bucket.bodyReads).toBe(pulls);
});
it('concurrent user-work calls retain their own source callback, without a mutable shared guard', async () => {
  const { s } = await pair(), d = await s.deps(), work = d.target!.userWork;
  const results = await Promise.allSettled([
    work.exportAll({ caseId: CASE, async beforeRead() { throw contractError('forbidden'); } }),
    work.exportAll({ caseId: CASE, async beforeRead() { await d.nativeEvidence!.audit!.requireCaseAudit({ identity: d.identity, caseId: CASE }); } }),
  ]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'forbidden' } });
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: { format: 'clearcase.user-work/1' } });
});
it('a retained source reference does not outlive its case-audit view', async () => {
  const s = await source(); let deny = false;
  s.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); if (deny) throw contractError('forbidden'); } };
  const d = await s.deps(), out = await exportNativeCase(d, req), ref = out.manifest.references[0]!, reads = s.bucket.reads.length;
  const { blob: _blob, objectVersion: _version, etag: _etag, ...binding } = ref;
  deny = true;
  await expect(d.nativeEvidence!.read(binding)).rejects.toMatchObject({ code: 'forbidden' });
  expect(s.bucket.reads.length).toBe(reads);
});
