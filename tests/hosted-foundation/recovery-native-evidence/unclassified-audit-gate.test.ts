// Synthetic SQLite/streamed R2; real controllers, audit gate, intake and native adapters. No native acceptance.
import { afterEach, expect, it } from 'vitest';
import { exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { parseNativeManifest, verifyNativeExport } from '../../../src/lib/recovery/hosted/native-evidence.ts';
import { canonicalJson, encode } from '../../../src/lib/recovery/hosted/bytes.ts';
import { applyNativeRestore, planNativeRestore } from '../../../src/lib/recovery/hosted/restore.ts';
import { world, CASE, type World } from '../recovery-native-adapters/world.ts';
import { submit } from '../storage/fixture.ts';
import { pdf } from '../../results-review/native/fixtures.ts';
import { auditViewers, auditViewKey, nativeWorld, POLICY, req } from './world.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const noAudit = { maxLineageRows: POLICY.maxLineageRows, maxLineageBytes: POLICY.maxLineageBytes };
async function source(auditFree: boolean) {
  if (!auditFree) { const s = await nativeWorld(); worlds.push(s); return s; }
  const s = await world(); worlds.push(s);
  await submit(s, CASE, [{ path: 'folder/source.pdf', bytes: pdf('audit-free archive'), ref: 'content-only' }]);
  s.options.nativeEvidence = { ...POLICY };
  return s;
}
it('missing gate refuses before reading an audit-bearing private manifest', async () => {
  const s = await source(false), out = await exportNativeCase(await s.deps(), req);
  s.options.nativeEvidence = { ...noAudit, visibility: s.options.nativeEvidence!.visibility };
  const d = await s.deps(), reads = s.bucket.reads.length, pulls = s.bucket.bodyReads;
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: out.manifestSha256 })).rejects.toMatchObject({ code: 'recovery-unavailable' });
  expect(s.bucket.reads.length - reads).toBe(0); expect(s.bucket.bodyReads - pulls).toBe(0);
});
it.each([false, true])('all /2 controllers gate unclassified reads, audit-free=%s', async (auditFree) => {
  const s = await source(auditFree), t = await world(true, true, s.identity.principal!.kind === 'staff'); worlds.push(t);
  s.options.target = t.options;
  const d = await s.deps(), out = await exportNativeCase(d, { ...req, auditScope: auditFree ? 'none' : 'case-audit/1' });
  expect(out.manifest.evidence.audit).toBe(auditFree ? 'none' : 'case-audit/1');
  const r = { ...req, expectedManifestSha256: out.manifestSha256 }, plan = await planNativeRestore(d, r);
  const withAudit = s.options.nativeEvidence!, key = auditViewKey({ principal: s.identity.principal!, sessionId: s.identity.sessionId!, caseId: CASE });
  for (const mode of ['missing', 'denied', 'fault', 'revoked-session', 'revoked-grant'] as const) {
    s.options.nativeEvidence = { ...withAudit };
    if (mode === 'missing') delete s.options.nativeEvidence.audit;
    if (mode === 'fault') s.options.nativeEvidence.audit = { async caseAudit() { throw new Error('synthetic audit gate fault'); } };
    const blocked = await s.deps();
    if (mode === 'denied') auditViewers.delete(key);
    if (mode === 'revoked-session') s.state.revoked = true;
    if (mode === 'revoked-grant') s.revokeGrant();
    const before = { reads: s.bucket.reads.length, pulls: s.bucket.bodyReads, puts: s.bucket.puts.length, sessions: s.sessions.length,
      targetReads: t.bucket.reads.length, targetPulls: t.bucket.bodyReads, targetPuts: t.bucket.puts.length };
    const statements: string[] = [], originals = [s, t].map((w) => ({ prepare: w.db.prepare, head: w.bucket.head }));
    let heads = 0;
    for (const w of [s, t]) {
      const head = w.bucket.head.bind(w.bucket);
      w.bucket.head = async (k) => { heads++; return head(k); };
      const prepare = w.db.prepare.bind(w.db);
      w.db.prepare = (sql) => {
        // Authority predicates and audit append/reconciliation of their own events are not archive reads.
        if (/\b(?:uw_|rs_results_version\b|submissions_|native_candidate|native_import_)/.test(sql)) statements.push(sql);
        return prepare(sql);
      };
    }
    for (const action of [
      () => exportNativeCase(blocked, { ...req, exportId: 'blocked-export', auditScope: 'none' }),
      () => verifyNativeExport(blocked, r),
      () => planNativeRestore(blocked, r),
      () => applyNativeRestore(blocked, { ...r, confirmedPlanSha256: plan.planSha256, operationId: 'blocked-apply' }),
    ]) await expect(action()).rejects.toMatchObject({ code: mode === 'missing' || mode === 'fault' ? 'recovery-unavailable' : mode === 'revoked-session' ? 'invalid-session' : 'forbidden' });
    expect({ reads: s.bucket.reads.length, pulls: s.bucket.bodyReads, puts: s.bucket.puts.length, sessions: s.sessions.length,
      targetReads: t.bucket.reads.length, targetPulls: t.bucket.bodyReads, targetPuts: t.bucket.puts.length }).toEqual(before);
    expect(statements).toEqual([]); expect(heads).toBe(0);
    [s, t].forEach((w, i) => { w.db.prepare = originals[i]!.prepare; w.bucket.head = originals[i]!.head; });
    expect(t.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
    auditViewers.add(key); s.state.revoked = false;
    if (mode === 'revoked-grant') s.db.exec("UPDATE tenant_case_grants SET state = 'active', revoked_at = NULL WHERE grant_id = 'g1'");
  }
});
it.each(['none', 'case-audit/1'] as const)('direct %s capture still needs the live gate before primary history', async (scope) => {
  const s = await source(true), withAudit = s.options.nativeEvidence!;
  for (const missing of [true, false]) {
    s.options.nativeEvidence = missing ? { ...noAudit } : withAudit;
    const d = await s.deps(), key = auditViewKey({ principal: s.identity.principal!, sessionId: s.identity.sessionId!, caseId: CASE });
    auditViewers.delete(key);
    const sessions = s.sessions.length, reads = s.bucket.reads.length;
    await expect(d.nativeEvidence!.capture({ audit: scope })).rejects.toMatchObject({ code: missing ? 'recovery-unavailable' : 'forbidden' });
    expect(s.sessions.length).toBe(sessions); expect(s.bucket.reads.length).toBe(reads);
    auditViewers.add(key);
  }
});
it('pure audit-free /2 parsing needs no gate and performs no storage IO', async () => {
  const s = await source(true), d = await s.deps(), out = await exportNativeCase(d, { ...req, auditScope: 'none' });
  s.options.nativeEvidence = { ...noAudit };
  const noHook = await s.deps(), reads = s.bucket.reads.length, sessions = s.sessions.length;
  expect(noHook.nativeEvidence!.audit).toBeNull();
  expect(await parseNativeManifest(encode(canonicalJson(out.manifest)), noHook.nativeEvidence!.limits)).toEqual(out.manifest);
  expect(s.bucket.reads.length).toBe(reads); expect(s.sessions.length).toBe(sessions);
});
it('audit-free verification and restore recheck the gate after manifest IO and before release', async () => {
  const s = await source(true), t = await world(true); worlds.push(t); s.options.target = t.options;
  const d = await s.deps(), out = await exportNativeCase(d, { ...req, auditScope: 'none' }), r = { ...req, expectedManifestSha256: out.manifestSha256 };
  const key = auditViewKey({ principal: s.identity.principal!, sessionId: s.identity.sessionId!, caseId: CASE });
  const get = s.bucket.get.bind(s.bucket);
  s.bucket.get = async (k) => { const result = await get(k); if (k === out.manifestKey) auditViewers.delete(key); return result; };
  const reads = s.bucket.reads.length, pulls = s.bucket.bodyReads;
  await expect(verifyNativeExport(d, r)).rejects.toMatchObject({ code: 'forbidden' });
  expect(s.bucket.reads.slice(reads).filter((k) => k !== 'identity/client.json')).toEqual([out.manifestKey]);
  expect(s.bucket.bodyReads).toBe(pulls);
  s.bucket.get = get; auditViewers.add(key);
  const append = s.options.audit.append.bind(s.options.audit); let planEvents = 0;
  const late = { ...d, audit: { async append(event: Parameters<typeof append>[0]) {
    const result = await append(event);
    if (event.action === 'recovery.restore.plan' && ++planEvents === 2) auditViewers.delete(key);
    return result;
  } } };
  await expect(planNativeRestore(late, r)).rejects.toMatchObject({ code: 'forbidden' });
  expect(planEvents).toBeGreaterThanOrEqual(2); expect(t.bucket.puts).toEqual([]);
  auditViewers.add(key);
  const plan = await planNativeRestore(d, r), head = t.bucket.head.bind(t.bucket);
  t.bucket.head = async (k) => { const result = await head(k); if (k.includes('/blobs/')) auditViewers.delete(key); return result; };
  await expect(applyNativeRestore(d, { ...r, confirmedPlanSha256: plan.planSha256, operationId: 'audit-free-head-revoked' })).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(t.bucket.puts).toEqual([]);
  t.bucket.head = head; auditViewers.add(key);
  const result = await applyNativeRestore(d, { ...r, confirmedPlanSha256: plan.planSha256, operationId: 'audit-free-restore' });
  expect(result).toMatchObject({ ok: true, activated: false });
  expect(result.invariants.every((x) => x.ok)).toBe(true);
  for (const table of ['rs_publication', 'native_candidate', 'rs_case_original', 'submissions_revision']) expect(t.db.rows(`SELECT * FROM ${table}`)).toEqual([]);
});
