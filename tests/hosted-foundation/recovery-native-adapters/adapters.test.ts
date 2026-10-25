import { afterEach, describe, expect, it } from 'vitest';
import { createNativeRecoveryAdapters, type NativeRecoveryLimits } from '../../../src/lib/recovery/hosted/native-adapters.ts';
import { exportCase, verifyExport, planRestore, applyRestore } from '../../../src/lib/recovery/hosted/index.ts';
import { sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { world, CASE, CLIENT, enc, exportKey, blobKey, type World } from './world.ts';

const worlds: World[] = [];
async function setup(isolated = false, workBound = true) { const w = await world(isolated, workBound); worlds.push(w); return w; }
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const request = { caseId: CASE, exportId: 'e1', includeUserWork: true };

describe('native configuration and genuine receiving-request authority (synthetic transport)', () => {
  it('uses one first-primary session for source services, catalogue and policy', async () => {
    const w = await setup(); const d = await w.deps();
    expect(w.sessions).toEqual(['first-primary']);
    expect(d.profile).toBe('production'); expect(d.target).toBeNull();
    expect(d.objects?.kind).toBe('durable-private'); expect(d.visibility?.kind).toBe('current-policy');
    expect('url' in d.objects!).toBe(false);
  });
  it.each(['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxManifestBytes'] as const)('requires finite %s without a default', async (key) => {
    const w = await setup();
    for (const value of [undefined, null, 0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER]) {
      const limits = { ...w.options.limits, [key]: value } as NativeRecoveryLimits;
      await expect(createNativeRecoveryAdapters({ ...w.options, limits })).rejects.toMatchObject({ code: 'recovery-unavailable' });
    }
    expect(w.bucket.puts).toEqual([]);
  });
  it('refuses crossed source resource identities, storage identities, and unprovisioned UW', async () => {
    const w = await setup();
    w.resources.boundResources.r2Bucket = 'crossed-bucket';
    await expect(w.deps()).rejects.toMatchObject({ code: 'recovery-unavailable' });
    w.resources.boundResources.r2Bucket = w.resources.deployment.r2Bucket;
    w.bucket.setRaw('identity/client.json', enc('{"client_id":"client-b"}'));
    await expect(w.deps()).rejects.toMatchObject({ code: 'recovery-unavailable' });
    w.bucket.setRaw('identity/client.json', enc(JSON.stringify({ client_id: CLIENT })));
    const unbound = await setup(false, false);
    await expect(unbound.deps()).rejects.toMatchObject({ code: 'recovery-unavailable' });
    expect(w.bucket.puts).toEqual([]);
  });
  it('does not accept a forged Identity wrapper, crossed case/client or unknown version', async () => {
    const w = await setup(); const p = await w.stage(); w.publish(p.identity.resultsVersion);
    const d = await w.deps(), visible = d.visibility!;
    const q = { identity: w.identity, caseId: CASE, resultsVersion: p.identity.resultsVersion };
    expect(await visible.isVisible(q)).toBe(true);
    expect(await visible.isVisible({ ...q, identity: { ...w.identity, authorize: async () => {}, checkRevocation: async () => {} } })).toBe(false);
    expect(await visible.isVisible({ ...q, identity: { ...w.identity, clientId: id('client', 'client-b') } })).toBe(false);
    expect(await visible.isVisible({ ...q, caseId: id('case', 'case-b') })).toBe(false);
    expect(await visible.isVisible({ ...q, resultsVersion: resultsVersion(`sha256:${'f'.repeat(64)}`) })).toBe(false);
  });
  it('checks live explicit grants and fresh sessions, not archived publication or staff kind', async () => {
    const w = await setup(); const p = await w.stage(); w.publish(p.identity.resultsVersion);
    const d = await w.deps(), q = { identity: w.identity, caseId: CASE, resultsVersion: p.identity.resultsVersion };
    expect(await d.visibility!.isVisible(q)).toBe(true);
    w.revokeGrant(); expect(await d.visibility!.isVisible(q)).toBe(false);
    w.state.revoked = true; expect(await d.visibility!.isVisible(q)).toBe(false);
    expect(w.db.rows<{ outcome: string }>("SELECT outcome FROM native_audit_events WHERE outcome = 'denied'").length).toBeGreaterThan(0);
  });
  it('rechecks a session revoked during the fresh grant/audit lookup', async () => {
    const w = await setup(); const p = await w.stage(); w.publish(p.identity.resultsVersion);
    const d = await w.deps(); w.state.afterAuthorize = () => { w.state.revoked = true; };
    expect(await d.visibility!.isVisible({ identity: w.identity, caseId: CASE, resultsVersion: p.identity.resultsVersion })).toBe(false);
  });
  it('holds unknown current policy instead of treating a storage fault as visible', async () => {
    const w = await setup(); const p = await w.stage(); w.publish(p.identity.resultsVersion);
    const d = await w.deps(); w.db.failNext = /FROM rs_case c LEFT JOIN/;
    await expect(d.visibility!.isVisible({ identity: w.identity, caseId: CASE, resultsVersion: p.identity.resultsVersion })).rejects.toMatchObject({ code: 'recovery-unavailable' });
  });
});

describe('private immutable R2 adapter with exact streaming readback', () => {
  it('writes conditionally, hashes input/readback, and never exposes a public URL', async () => {
    const w = await setup(); const d = await w.deps(), bytes = enc('synthetic archive'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
    expect(await d.objects!.putIfAbsent({ key, bytes, sha256 })).toEqual({ kind: 'created' });
    expect(await d.objects!.putIfAbsent({ key, bytes, sha256 })).toEqual({ kind: 'exists' });
    expect(await d.objects!.get(key)).toEqual(bytes);
    expect(await d.objects!.get(exportKey())).toBeNull();
    expect(w.bucket.puts).toEqual([key]);
    await expect(d.objects!.putIfAbsent({ key: exportKey(), bytes: new Uint8Array(w.options.limits.maxManifestBytes + 1), sha256 })).rejects.toMatchObject({ code: 'export-too-large' });
    await expect(d.objects!.putIfAbsent({ key, bytes: new Uint8Array(w.options.limits.maxFileBytes + 1), sha256 })).rejects.toMatchObject({ code: 'export-too-large' });
    await expect(d.objects!.putIfAbsent({ key, bytes: enc('forged'), sha256 })).rejects.toMatchObject({ code: 'export-corrupt' });
    await expect(d.objects!.get(key.replace(CASE, 'other-case'))).rejects.toMatchObject({ code: 'foreign-input' });
    await expect(d.objects!.get(key.replace(CLIENT, 'client-b'))).rejects.toMatchObject({ code: 'foreign-input' });
    await expect(d.objects!.get(`recovery/exports/${CLIENT}/${CASE}/e1/../manifest.json`)).rejects.toMatchObject({ code: 'foreign-input' });
  });
  it('never overwrites when two simultaneous writes pass the first head', async () => {
    const w = await setup(); const d = await w.deps(), bytes = enc('concurrent'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
    const results = await Promise.all([d.objects!.putIfAbsent({ key, bytes, sha256 }), d.objects!.putIfAbsent({ key, bytes, sha256 })]);
    expect(results.map((r) => r.kind).sort()).toEqual(['created', 'exists']);
    expect(await d.objects!.get(key)).toEqual(bytes);
  });
  it('survives a conditional same-byte race and a lost acknowledgement without overwriting', async () => {
    const w = await setup(); const d = await w.deps(), bytes = enc('same'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
    w.bucket.beforePut = async () => { w.bucket.setRaw(key, bytes); const stored = w.bucket.objects.get(key)!; stored.sha256 = sha256; };
    expect(await d.objects!.putIfAbsent({ key, bytes, sha256 })).toEqual({ kind: 'exists' });
    const other = exportKey('ack-loss'); w.bucket.ackLoss = true;
    expect(await d.objects!.putIfAbsent({ key: other, bytes, sha256 })).toEqual({ kind: 'exists' });
    expect(await d.objects!.get(other)).toEqual(bytes);
  });
  it('refuses a differing race and retains the winner unchanged', async () => {
    const w = await setup(); const d = await w.deps(), bytes = enc('wanted'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
    w.bucket.beforePut = async () => { w.bucket.setRaw(key, enc('winner')); w.bucket.objects.get(key)!.sha256 = await sha256Hex(enc('winner')); };
    await expect(d.objects!.putIfAbsent({ key, bytes, sha256 })).rejects.toMatchObject({ code: 'export-corrupt' });
    expect(w.bucket.objects.get(key)!.bytes).toEqual(enc('winner'));
  });
  it.each(['oversize', 'checksum', 'key', 'truncated', 'overrun', 'corrupt'] as const)('refuses %s objects before releasing any bytes', async (fault) => {
    const w = await setup(); const d = await w.deps(), bytes = enc('original'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
    await d.objects!.putIfAbsent({ key, bytes, sha256 });
    const before = w.bucket.bodyReads;
    w.bucket.alter = (k, o) => {
      if (k !== key) return o;
      if (fault === 'oversize') return { ...o, size: w.options.limits.maxFileBytes + 1 };
      if (fault === 'checksum') return { ...o, checksums: {} };
      if (fault === 'key') return { ...o, key: 'crossed' };
      const value = fault === 'truncated' ? bytes.slice(0, -1) : fault === 'overrun' ? enc('longer-than-original') : enc('corrupt!');
      return { ...o, body: new ReadableStream({ start(c) { c.enqueue(value); c.close(); } }) };
    };
    await expect(d.objects!.get(key)).rejects.toMatchObject({ code: fault === 'oversize' ? 'export-too-large' : 'export-corrupt' });
    if (['oversize', 'checksum', 'key'].includes(fault)) { expect(w.bucket.bodyReads).toBe(before); expect(w.bucket.cancelled).toBeGreaterThan(0); }
  });
  it('does not switch an existing port to a new caller/case when its input configuration is reused', async () => {
    const w = await setup(); const d = await w.deps(), bytes = enc('bound to original request'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
    await d.objects!.putIfAbsent({ key, bytes, sha256 });
    w.options.caseId = id('case', 'new-request-case');
    w.options.identity = { ...w.identity, checkRevocation: async () => {}, authorize: async () => {} };
    w.state.revoked = true;
    await expect(d.objects!.get(key)).rejects.toMatchObject({ code: 'invalid-session' });
    expect(Object.isFrozen(d)).toBe(true); expect(Object.isFrozen(d.limits)).toBe(true);
  });
  it('checks revocation after the slow object read, not just before it', async () => {
    const w = await setup(); const d = await w.deps(), bytes = enc('protected'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
    await d.objects!.putIfAbsent({ key, bytes, sha256 });
    w.bucket.afterGet = (k) => { if (k === key) w.state.revoked = true; };
    await expect(d.objects!.get(key)).rejects.toMatchObject({ code: 'invalid-session' });
  });
});

describe('same-primary previews and complete source policy', () => {
  it('enumerates the actual rs_preview identities and holds private/withdrawn previews', async () => {
    const w = await setup(); const p = await w.stage(); await w.preview(p.identity.resultsVersion);
    const d = await w.deps(), q = { caseId: CASE, resultsVersion: p.identity.resultsVersion };
    await expect(d.previews!.previewsOf(q)).rejects.toMatchObject({ code: 'not-found' });
    w.publish(q.resultsVersion);
    expect(await d.previews!.previewsOf(q)).toEqual([{ assetId: 'preview-OD-001', filename: 'supplied-preview.pdf', mediaType: 'application/pdf', size: enc('synthetic published preview').length }]);
    w.db.exec("INSERT INTO rs_version_withdrawal VALUES (?, ?, ?)", q.resultsVersion, CASE, '2026-10-25T12:00:00Z');
    await expect(d.previews!.previewsOf(q)).rejects.toMatchObject({ code: 'not-found' });
  });
  it.each(['grant', 'withdrawal'] as const)('rechecks %s after awaited catalogue work', async (fault) => {
    const w = await setup(); const p = await w.stage(); await w.preview(p.identity.resultsVersion); w.publish(p.identity.resultsVersion);
    const d = await w.deps();
    const prepare = w.db.prepare.bind(w.db);
    w.db.prepare = (sql) => {
      const stmt = prepare(sql);
      if (!sql.includes('SELECT p.asset_id, p.filename')) return stmt;
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...values) => { const bound = bind(...values), all = bound.all.bind(bound); bound.all = async <T>() => { const result = await all<T>(); if (fault === 'grant') w.revokeGrant(); else w.db.exec("UPDATE rs_publication SET state = 'withdrawn' WHERE case_id = ?", CASE); return result; }; return bound; };
      return stmt;
    };
    await expect(d.previews!.previewsOf({ caseId: CASE, resultsVersion: p.identity.resultsVersion })).rejects.toMatchObject({ code: 'not-found' });
  });
  it('exports actual package, originals, preview and D1 work with unchanged identities/provenance', async () => {
    const w = await setup(); const p = await w.stage(); const preview = await w.preview(p.identity.resultsVersion); w.publish(p.identity.resultsVersion);
    const d = await w.deps();
    await d.userWork.exportAll({ caseId: CASE });
    const result = await exportCase(d, request);
    expect(result.manifest.caseId).toBe(CASE);
    expect(result.manifest.resultsVersions[0]!.version.id).toBe(p.identity.resultsVersion);
    expect(result.manifest.resultsVersions[0]!.version.manifest_sha256).toBe(p.identity.manifestSha256);
    expect(result.manifest.originals.map((o) => o.assetId)).toEqual(p.docs.map((x) => x.ref));
    expect(result.manifest.previews[0]!.sha256).toBe(await sha256Hex(preview));
    for (const file of result.manifest.resultsVersions[0]!.files) expect(await d.objects!.get(`recovery/exports/${CLIENT}/${CASE}/e1/${file.blob}`)).toEqual(p.files.get(file.path));
    expect(await verifyExport(d, { ...request, expectedManifestSha256: result.manifestSha256 })).toMatchObject({ manifestSha256: result.manifestSha256 });
  });
  it('requires preview count/size and complete-export budgets without partial manifests', async () => {
    const w = await setup(); const p = await w.stage(); await w.preview(p.identity.resultsVersion, 'one'); await w.preview(p.identity.resultsVersion, 'two'); w.publish(p.identity.resultsVersion);
    w.options.limits.maxFiles = 1;
    const d = await w.deps();
    await expect(d.previews!.previewsOf({ caseId: CASE, resultsVersion: p.identity.resultsVersion })).rejects.toMatchObject({ code: 'export-too-large' });
    await expect(exportCase(d, request)).rejects.toMatchObject({ code: 'export-too-large' });
    expect(w.bucket.objects.has(exportKey())).toBe(false);
  });
  it('does not silently omit a private or superseded version as production versionsOf would', async () => {
    const w = await setup(); const first = await w.stage('first'); w.publish(first.identity.resultsVersion);
    await w.stage('private');
    const d = await w.deps();
    await expect(exportCase(d, request)).rejects.toMatchObject({ code: 'not-found' });
    expect(w.bucket.objects.has(exportKey())).toBe(false);
  });
  it('retained exports hold after withdrawal, late session revocation and supersession', async () => {
    const w = await setup(); const p = await w.stage(); w.publish(p.identity.resultsVersion);
    const d = await w.deps(), result = await exportCase(d, request), req = { ...request, expectedManifestSha256: result.manifestSha256 };
    w.bucket.afterGet = (k) => { if (k.endsWith('manifest.json')) w.state.revoked = true; };
    // Existing loadExport maps object-port refusals to storage-unavailable; the port still releases no bytes.
    await expect(verifyExport(d, req)).rejects.toMatchObject({ code: 'storage-unavailable' });
    w.bucket.afterGet = null; w.state.revoked = false;
    const newer = await w.stage('newer'); w.publish(newer.identity.resultsVersion);
    await expect(verifyExport(d, req)).rejects.toMatchObject({ code: 'not-found' });
    w.publish(p.identity.resultsVersion); w.db.exec("UPDATE rs_publication SET state = 'withdrawn' WHERE case_id = ?", CASE);
    await expect(verifyExport(d, req)).rejects.toMatchObject({ code: 'not-found' });
  });
  it('holds native submission lineage that /1 cannot represent; never rewrites ids', async () => {
    const w = await setup(); const p = await w.stage(); w.publish(p.identity.resultsVersion);
    w.db.exec(`INSERT INTO submissions_upload (client_id, case_id, operation_id, asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at)
      VALUES (?, ?, 'native-submission-0001', 'sub-native-submission-0001', 'folder/source.pdf', 'source.pdf', 'application/pdf', 1, ?, 'received', ?, 'synthetic-editor', ?)`, CLIENT, CASE, 'a'.repeat(64), w.resources.deployment.clientIssuer, '2026-10-25T12:00:00Z');
    const d = await w.deps();
    await expect(exportCase(d, request)).rejects.toMatchObject({ code: 'recovery-unavailable' });
    expect(w.bucket.objects.has(exportKey())).toBe(false);
  });
});

describe('positively separate target, existing exact non-destructive staging contract', () => {
  async function pair() { const source = await setup(), target = await setup(true); source.options.target = target.options; return { source, target }; }
  it('rejects a renamed wrapper over the live binding identity', async () => {
    const source = await setup(), target = await setup(true);
    target.options.resources.boundResources = { ...source.resources.boundResources, worker: 'renamed' };
    target.options.resources.deployment = { ...source.resources.deployment, worker: 'renamed' };
    source.options.target = target.options;
    await expect(source.deps()).rejects.toMatchObject({ code: 'target-not-isolated' });
    expect(target.bucket.puts).toEqual([]);
  });
  it.each(['missing', 'crossed', 'unbound', 'no-grant', 'other-actor'] as const)('leaves %s target null rather than provisioning or fabricating authority', async (fault) => {
    const source = await setup(), target = await setup(true, fault !== 'unbound'); source.options.target = target.options;
    if (fault === 'missing') target.db.exec('DELETE FROM rs_case');
    if (fault === 'crossed') target.bucket.setRaw('identity/client.json', enc('{"client_id":"client-b"}'));
    if (fault === 'no-grant') target.revokeGrant();
    if (fault === 'other-actor') target.options.identity = { ...target.identity, principal: { ...target.identity.principal!, subject: 'different-person' }, kind: 'verified', sessionId: id('session', 'different') };
    if (fault === 'other-actor') await expect(source.deps()).rejects.toMatchObject({ code: 'target-not-isolated' });
    else {
      const d = await source.deps(); expect(d.target).toBeNull();
      await expect(planRestore(d, { caseId: CASE, exportId: 'e1', expectedManifestSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'recovery-unavailable' });
    }
    expect(target.bucket.puts).toEqual([]); expect(target.db.rows('SELECT * FROM uw_case')).toEqual([]);
  });
  it('uses the genuine isolated D1 snapshot/import APIs; keeps case/ref/anchor identity and never publishes', async () => {
    const { source, target } = await pair(), p = await source.stage(); source.publish(p.identity.resultsVersion);
    const d = await source.deps(); expect(d.target).not.toBeNull();
    const work = await source.deps();
    // The real D1 writer creates this source note; only exportAll is exposed by the recovery deps.
    const actual = source.work();
    const note = await actual.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'source-note', target: { kind: 'document', anchor: await actual.anchorFor({ caseId: CASE, resultsVersion: p.identity.resultsVersion, ref: 'OD-001' }) }, body: 'Synthetic preserved note' });
    expect(note.kind).toBe('written');
    const result = await exportCase(work, request), req = { ...request, expectedManifestSha256: result.manifestSha256 };
    const plan = await planRestore(d, req);
    expect(plan).toMatchObject({ destructive: false, deletes: 0, target: { caseId: CASE }, source: { caseId: CASE } });
    await expect(applyRestore(d, { ...req, confirmedPlanSha256: 'b'.repeat(64), operationId: 'wrong-plan' })).rejects.toMatchObject({ code: 'plan-mismatch' });
    expect(target.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
    const report = await applyRestore(d, { ...req, confirmedPlanSha256: plan.planSha256, operationId: 'restore-1' });
    expect(report).toMatchObject({ ok: true, activated: false, userWork: { imported: { rows: 1, deleted: 0, replaced: 0 } } });
    expect(target.db.rows<{ case_id: string; target_json: string }>('SELECT case_id, target_json FROM uw_note')).toEqual(source.db.rows('SELECT case_id, target_json FROM uw_note'));
    expect(target.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
    expect(target.db.rows('SELECT * FROM rs_publication')).toEqual([]);
    expect(target.db.rows('SELECT * FROM native_candidate')).toEqual([]);
    expect(target.db.rows('SELECT * FROM uw_snapshot')).toHaveLength(1);
    expect(target.db.rows('SELECT * FROM tenant_case_grants')).toHaveLength(1);
    expect(target.bucket.puts.every((key) => key.startsWith(`restore/${CLIENT}/${CASE}/e1/`))).toBe(true);
  });
  it('guards the REAL target expected revision when another writer arrives after the snapshot', async () => {
    const { source, target } = await pair(), p = await source.stage(); source.publish(p.identity.resultsVersion);
    const d = await source.deps(), result = await exportCase(d, request), req = { ...request, expectedManifestSha256: result.manifestSha256 };
    const plan = await planRestore(d, req);
    target.bucket.beforePut = async () => {
      const r = await target.work().addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'concurrent-target-note', target: { kind: 'case' }, body: 'Concurrent work must survive' });
      expect(r.kind).toBe('written');
    };
    await expect(applyRestore(d, { ...req, confirmedPlanSha256: plan.planSha256, operationId: 'stale-restore' })).rejects.toMatchObject({ code: 'stale-state' });
    expect(target.db.rows('SELECT body FROM uw_note')).toEqual([{ body: 'Concurrent work must survive' }]);
    expect(target.db.rows('SELECT * FROM uw_snapshot')).toHaveLength(1);
    expect(target.db.rows('SELECT * FROM rs_publication')).toEqual([]);
  });
  it('requires immutable staging integrity before any actual D1 import', async () => {
    const { source, target } = await pair(), p = await source.stage(); source.publish(p.identity.resultsVersion);
    const d = await source.deps(), result = await exportCase(d, request), req = { ...request, expectedManifestSha256: result.manifestSha256 };
    const plan = await planRestore(d, req);
    target.bucket.alter = (key, o) => key.includes('/blobs/') ? { ...o, body: new ReadableStream({ start(c) { c.enqueue(enc('corrupt staging')); c.close(); } }) } : o;
    await expect(applyRestore(d, { ...req, confirmedPlanSha256: plan.planSha256, operationId: 'corrupt-staging' })).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(target.db.rows('SELECT * FROM uw_operation')).toEqual([]);
    expect(target.db.rows('SELECT * FROM uw_snapshot')).toHaveLength(1);
    expect(target.db.rows('SELECT * FROM rs_publication')).toEqual([]);
  });
  it('does not accept a populated target or a late target grant revocation', async () => {
    const { source, target } = await pair(), p = await source.stage(); source.publish(p.identity.resultsVersion);
    const d = await source.deps(), result = await exportCase(d, request), req = { ...request, expectedManifestSha256: result.manifestSha256 };
    const plan = await planRestore(d, req);
    const actual = target.work();
    expect((await actual.addNote({ caseId: CASE, expected: { kind: 'absent' }, operationId: 'target-note', target: { kind: 'case' }, body: 'Do not destroy this' })).kind).toBe('written');
    await expect(applyRestore(d, { ...req, confirmedPlanSha256: plan.planSha256, operationId: 'populated-target' })).rejects.toMatchObject({ code: 'target-not-empty' });
    expect(target.db.rows('SELECT body FROM uw_note')).toEqual([{ body: 'Do not destroy this' }]);
    target.revokeGrant();
    await expect(applyRestore(d, { ...req, confirmedPlanSha256: plan.planSha256, operationId: 'revoked-target' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(target.bucket.puts).toEqual([]); expect(target.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
  });
});
