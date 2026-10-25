// M3 audit-view authority and session privacy, M4 unfinished immutable records. Synthetic SQLite/R2 transports only.
import { afterEach, expect, it } from 'vitest';
import { exportCase, exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { parseNativeManifest, verifyNativeExport, type NativeExportManifest } from '../../../src/lib/recovery/hosted/native-evidence.ts';
import { applyNativeRestore, planNativeRestore } from '../../../src/lib/recovery/hosted/restore.ts';
import { canonicalJson, encode, sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { requestAuditSink } from '../../../src/lib/audit/index.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { world, CASE, CLIENT, now, type World } from '../recovery-native-adapters/world.ts';
import { submit } from '../storage/fixture.ts';
import { pdf } from '../../results-review/native/fixtures.ts';
import { AUDIT_GATE, auditViewers, auditViewKey, nativeWorld, POLICY, req, type NativeWorld } from './world.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const CONTENT_ONLY = { maxLineageRows: POLICY.maxLineageRows, maxLineageBytes: POLICY.maxLineageBytes };
const exportWrites = (w: World) => w.bucket.puts.filter((k) => k.includes('/native-e1/'));
async function setup(correction = false) { const w = await nativeWorld(correction); worlds.push(w); return w; }
const revokeAuditView = (w: NativeWorld) => auditViewers.delete(auditViewKey({ principal: w.identity.principal!, sessionId: w.identity.sessionId!, caseId: CASE }));
async function reseal(w: World, key: string, m: NativeExportManifest) {
  const e = m.evidence;
  e.rows = Object.values(e.tables).reduce((n, r) => n + r.length, 0); e.bytes = encode(canonicalJson(e.tables)).length; e.sha256 = await sha256Hex(encode(canonicalJson(e.tables)));
  const bytes = encode(canonicalJson(m)), sha = await sha256Hex(bytes);
  w.bucket.setRaw(key, bytes); w.bucket.objects.get(key)!.sha256 = sha;
  return sha;
}
/** A client editor holding only a content grant, authenticated on the same deployment (probe P1's requester). */
function asContentEditor(w: World) {
  const principal = { issuer: 'https://clerk.client-a.example', subject: 'client-content-editor', kind: 'client' as const }, sessionId = id('session', 'client-content-session');
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES ('content-only', ?, 'case', ?, ?, ?, 'client', 'editor', 'content', 'active', 1, 'content-grant-op', '{}', 'https://clerk.staff.example', 'provisioner', ?)`, CLIENT, CASE, principal.issuer, principal.subject, now().toISOString());
  const audit = requestAuditSink({ db: w.db, config: w.auditConfig, requester: { kind: 'verified', principal, sessionId }, now }), deployment = w.options.resources.deployment;
  const authorizer = createCaseAuthorizer({ deployment, grants: d1GrantRepository(w.db), cases: d1CaseDirectory({ db: w.db, deployment }), audit, now });
  const identity: Identity = { kind: 'verified', principal, sessionId, clientId: CLIENT,
    async checkRevocation() {}, async authorize(q) { await authorizer.authorizeCase({ ...q, principal, sessionId }); } };
  w.options.identity = identity; w.options.audit = audit;
  return identity;
}
/** Runs the real intake with one R2 fault, leaving the upload at the persisted state that fault produces. */
async function interrupted(w: World, ref: string, at: 'put' | 'finalize') {
  const bytes = pdf(`unfinished ${ref}`), get = w.bucket.get.bind(w.bucket), put = w.bucket.put.bind(w.bucket), head = w.bucket.head.bind(w.bucket);
  if (at === 'put') w.bucket.put = async (...args) => { if (args[0].startsWith('orig/')) throw new Error('synthetic interrupted upload'); return put(...args); };
  else {
    w.bucket.get = async (key) => { if (key.startsWith('orig/')) throw new Error('synthetic finalize fault'); return get(key); };
    w.bucket.head = async (key) => { if (key.startsWith('orig/') && w.bucket.objects.has(key)) throw new Error('synthetic finalize fault'); return head(key); };
  }
  try { await submit(w, CASE, [{ ref, path: `pending/${ref}.pdf`, bytes }], { commit: false }); } finally { w.bucket.get = get; w.bucket.put = put; w.bucket.head = head; }
  return { bytes, sha256: await sha256Hex(bytes) };
}

it('RED M3: a content-only exporter receives no audit-bearing /2, with or without the audit hook', async () => {
  const w = await setup(); asContentEditor(w);
  w.options.nativeEvidence = { ...CONTENT_ONLY };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'recovery-unavailable' });
  w.options.nativeEvidence = { ...POLICY };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'forbidden' });
  expect(exportWrites(w)).toEqual([]);
  expect(w.db.rows("SELECT outcome FROM native_audit_events WHERE action = 'recovery.export' AND outcome = 'denied'")).toHaveLength(1);
});
it('a content-only exporter of a case without lineage gets /2 with no audit rows and no session material', async () => {
  const w = await world(); worlds.push(w);
  await submit(w, CASE, [{ path: 'folder/source.pdf', bytes: pdf('content only'), ref: 'content-only' }]);
  w.options.nativeEvidence = { ...CONTENT_ONLY };
  const d = await w.deps(), out = await exportNativeCase(d, req), m = out.manifest, text = canonicalJson(m);
  expect(m.evidence.audit).toBe('none');
  for (const t of ['native_audit_events', 'native_candidate_audit_intent', 'native_candidate_audit_settlement', 'native_candidate', 'native_import_attempt'] as const) expect(m.evidence.tables[t]).toEqual([]);
  expect(text).not.toContain(w.identity.sessionId!); expect(text).not.toContain(await sha256Hex(encode(w.identity.sessionId!)));
  expect(await verifyNativeExport(d, { ...req, expectedManifestSha256: out.manifestSha256 })).toMatchObject({ manifestSha256: out.manifestSha256 });
});
it('an entitled export archives audit as the audit reader shows it: no session ids, session digests or session-bearing hashes', async () => {
  const w = await setup(true), out = await exportNativeCase(await w.deps(), req), m = out.manifest, text = canonicalJson(m);
  expect(m.evidence.format).toBe('clearcase.native-evidence/2'); expect(m.evidence.audit).toBe('case-audit/1');
  expect(text).not.toContain(w.identity.sessionId!); expect(text).not.toContain(await sha256Hex(encode(w.identity.sessionId!))); expect(text).not.toContain('sessionSha256');
  const stored = w.db.rows<{ sha256: string }>('SELECT sha256 FROM native_audit_events');
  for (const r of stored) expect(text).not.toContain(r.sha256);
  for (const r of m.evidence.tables.native_audit_events!) expect(Object.keys(r)).not.toContain('sha256');
  for (const r of m.evidence.tables.native_candidate_audit_intent!) {
    expect(Object.keys(r)).not.toContain('event_sha256');
    expect(JSON.parse(String(r.archival_event))).toMatchObject({ actor: { kind: 'historical', principalKind: 'staff' }, redacted: ['actor.sessionId'] });
  }
});
it('refuses a resealed archive that drops its audit scope or restores a session digest', async () => {
  const w = await setup(), d = await w.deps(), out = await exportNativeCase(d, req);
  const scope = structuredClone(out.manifest); Object.assign(scope.evidence, { audit: 'none' });
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: await reseal(w, out.manifestKey, scope) })).rejects.toMatchObject({ code: 'recovery-unavailable' });
  const digest = structuredClone(out.manifest), intent = digest.evidence.tables.native_candidate_audit_intent![0]!, event = JSON.parse(String(intent.archival_event));
  event.actor.sessionSha256 = 'a'.repeat(64); intent.archival_event = canonicalJson(event);
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: await reseal(w, out.manifestKey, digest) })).rejects.toMatchObject({ code: 'manifest-invalid' });
});
it('rechecks the audit entitlement after preflight head, before any archive write', async () => {
  const w = await setup(), deps = await w.deps(), head = w.bucket.head.bind(w.bucket);
  w.bucket.head = async (key) => { if (key.includes('/native-e1/blobs/')) revokeAuditView(w); return head(key); };
  await expect(exportNativeCase(deps, req)).rejects.toMatchObject({ code: 'forbidden' });
  expect(exportWrites(w)).toEqual([]);
});
it('verify and restore planning need the live audit entitlement before any retained blob is read', async () => {
  const w = await setup(), deps = await w.deps(), out = await exportNativeCase(deps, req), ref = { ...req, expectedManifestSha256: out.manifestSha256 };
  const blobReads = () => w.bucket.reads.filter((k) => k.includes('/native-e1/blobs/')).length, before = blobReads();
  revokeAuditView(w);
  await expect(verifyNativeExport(deps, ref)).rejects.toMatchObject({ code: 'forbidden' });
  w.options.nativeEvidence = { ...CONTENT_ONLY, visibility: w.options.nativeEvidence!.visibility };
  await expect(verifyNativeExport(await w.deps(), ref)).rejects.toMatchObject({ code: 'recovery-unavailable' });
  expect(blobReads()).toBe(before);
});
it('restore apply refuses a revoked audit entitlement before the first target write', async () => {
  const source = await setup(true), target = await world(true, true, true); worlds.push(target);
  source.options.target = target.options;
  const deps = await source.deps(), out = await exportNativeCase(deps, req), ref = { ...req, expectedManifestSha256: out.manifestSha256 };
  const plan = await planNativeRestore(deps, ref);
  revokeAuditView(source);
  await expect(applyNativeRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'audit-revoked-restore' })).rejects.toMatchObject({ code: 'forbidden' });
  expect(target.bucket.puts).toEqual([]); expect(target.db.rows('SELECT * FROM uw_snapshot')).toEqual([]);
});
it('binds the gate to the exact request identity and case, and brackets its IO with live authority', async () => {
  const w = await setup(), deps = await w.deps(), port = deps.nativeEvidence!.audit!;
  await expect(port.requireCaseAudit({ identity: { ...w.identity }, caseId: CASE })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(port.requireCaseAudit({ identity: w.identity, caseId: id('case', 'case-b') })).rejects.toMatchObject({ code: 'forbidden' });
  w.options.nativeEvidence!.audit = { async caseAudit(a) { await AUDIT_GATE.caseAudit(a); w.state.revoked = true; } };
  await expect((await w.deps()).nativeEvidence!.audit!.requireCaseAudit({ identity: w.identity, caseId: CASE })).rejects.toMatchObject({ code: 'invalid-session' });
  w.options.nativeEvidence!.audit = { caseAudit: 'allow' } as never;
  w.state.revoked = false;
  await expect(w.deps()).rejects.toMatchObject({ code: 'recovery-unavailable' });
});
it('a gate fault is retryable uncertainty, never an allow, and a retry under the same id completes', async () => {
  const w = await setup(); let faults = 1;
  w.options.nativeEvidence!.audit = { async caseAudit(a) { if (faults-- > 0) throw new Error('D1_ERROR: grants unavailable'); return AUDIT_GATE.caseAudit(a); } };
  const deps = await w.deps();
  await expect(exportNativeCase(deps, req)).rejects.toMatchObject({ code: 'recovery-unavailable', retryable: true });
  expect(exportWrites(w)).toEqual([]);
  expect((await exportNativeCase(deps, req)).manifest.evidence.audit).toBe('case-audit/1');
});

it('RED M4: an unrelated interrupted upload is archived as received, not a recovery HOLD', async () => {
  const w = await setup(), pending = await interrupted(w, 'interrupted', 'put');
  expect(w.db.rows('SELECT state FROM submissions_upload WHERE path = ?', 'pending/interrupted.pdf')).toEqual([{ state: 'received' }]);
  const d = await w.deps(), out = await exportNativeCase(d, req), t = out.manifest.evidence.tables;
  const upload = t.submissions_upload!.find((r) => r.path === 'pending/interrupted.pdf')!;
  expect(upload).toMatchObject({ state: 'received', stored_at: null });
  expect(t.submissions_revision!.some((r) => r.operation_id === upload.operation_id)).toBe(false);
  expect(t.rs_original_upload!.find((r) => r.asset_id === upload.asset_id)).toMatchObject({ state: 'declared' });
  expect(out.manifest.references.some((r) => r.sha256 === pending.sha256)).toBe(false);
  expect(await verifyNativeExport(d, { ...req, expectedManifestSha256: out.manifestSha256 })).toMatchObject({ manifestSha256: out.manifestSha256 });
  await expect(exportCase(d, { ...req, exportId: 'legacy-hold' })).rejects.toMatchObject({ code: 'recovery-unavailable' });
  expect(() => w.db.exec('DELETE FROM submissions_upload WHERE path = ?', 'pending/interrupted.pdf')).toThrow();
});
it('RED M4: a stored, never-finalized upload keeps its verified bytes as a pending original, never a case original', async () => {
  const w = await setup(), pending = await interrupted(w, 'unbound', 'finalize');
  expect(w.db.rows('SELECT state FROM submissions_upload WHERE path = ?', 'pending/unbound.pdf')).toEqual([{ state: 'reserved' }]);
  const d = await w.deps(), out = await exportNativeCase(d, req), m = out.manifest;
  const ref = m.references.find((r) => r.sha256 === pending.sha256)!;
  expect(ref).toMatchObject({ kind: 'pending-original', objectKey: `orig/${pending.sha256}`, size: pending.bytes.length });
  expect(m.originals.some((o) => o.sha256 === pending.sha256)).toBe(false);
  expect(m.evidence.tables.rs_case_original!.some((o) => o.sha256 === pending.sha256)).toBe(false);
  expect(await d.objects!.get(out.manifestKey.replace('manifest.json', ref.blob))).toEqual(pending.bytes);
  expect(await verifyNativeExport(d, { ...req, expectedManifestSha256: out.manifestSha256 })).toMatchObject({ verifiedBlobs: new Set(m.references.map((r) => r.sha256)).size + 1 });
});
it('stages pending bytes without activating them, and budgets them with every other reference', async () => {
  const source = await setup(), target = await world(true, true, true); worlds.push(target);
  const pending = await interrupted(source, 'staged', 'finalize');
  source.options.target = target.options;
  const deps = await source.deps(), out = await exportNativeCase(deps, req), ref = { ...req, expectedManifestSha256: out.manifestSha256 };
  const plan = await planNativeRestore(deps, ref), result = await applyNativeRestore(deps, { ...ref, confirmedPlanSha256: plan.planSha256, operationId: 'pending-restore' });
  expect(result).toMatchObject({ ok: true, activated: false });
  expect(await deps.target!.objects.get(`restore/${CLIENT}/${CASE}/${req.exportId}/blobs/${pending.sha256}`)).toEqual(pending.bytes);
  for (const table of ['rs_case_original', 'rs_original', 'submissions_upload', 'rs_original_upload']) expect(target.db.rows(`SELECT * FROM ${table}`)).toEqual([]);
  const bytes = encode(canonicalJson(out.manifest)), entries = out.manifest.references.length + 1;
  await expect(parseNativeManifest(bytes, { ...deps.nativeEvidence!.limits, maxFiles: entries - 1 })).rejects.toMatchObject({ code: 'export-too-large' });
  source.options.nativeEvidence!.maxLineageRows = out.manifest.evidence.rows - 1;
  await expect(exportNativeCase(await source.deps(), { ...req, exportId: 'pending-cap' })).rejects.toMatchObject({ code: 'export-too-large' });
});
it.each(['missing', 'changed'] as const)('refuses %s pending-original bytes rather than inventing or dropping them', async (kind) => {
  const w = await setup(), pending = await interrupted(w, `pending-${kind}`, 'finalize'), key = `orig/${pending.sha256}`;
  if (kind === 'missing') w.bucket.objects.delete(key); else w.bucket.tamper(key, (b) => { b[0] ^= 1; return b; });
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: kind === 'missing' ? 'export-incomplete' : 'export-corrupt' });
  expect(exportWrites(w)).toEqual([]);
});
it('lineage still requires a finalized submission and every pending reference, even resealed', async () => {
  const w = await setup(), pending = await interrupted(w, 'strict', 'finalize'), d = await w.deps(), out = await exportNativeCase(d, req);
  const linked = structuredClone(out.manifest), t = linked.evidence.tables;
  const rev = t.submissions_revision!.find((r) => r.revision_id === t.native_import_link![0]!.submission_revision_id)!;
  t.submissions_upload!.find((u) => u.operation_id === rev.operation_id)!.state = 'reserved';
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: await reseal(w, out.manifestKey, linked) })).rejects.toMatchObject({ code: 'export-incomplete' });
  const dropped = structuredClone(out.manifest);
  dropped.references = dropped.references.filter((r) => r.sha256 !== pending.sha256);
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: await reseal(w, out.manifestKey, dropped) })).rejects.toMatchObject({ code: 'export-incomplete' });
  const received = structuredClone(out.manifest);
  received.evidence.tables.submissions_upload!.find((u) => u.path === 'pending/strict.pdf')!.state = 'received';
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: await reseal(w, out.manifestKey, received) })).rejects.toMatchObject({ code: 'manifest-invalid' });
});

const STAGING = `sha256:${'c'.repeat(64)}`;
function abandonedStaging(w: NativeWorld) {
  // The durable rows a crash leaves after stage()'s head batch and package-row batch, before any object is written.
  w.db.exec(`INSERT INTO rs_results_version (version_id, case_id, state, attempt, operation_id, manifest_sha256, input_revision_id, case_label, created, verdict, validator_version, diagnostics_sha256, warning_fingerprints,
    expected_documents, expected_assets, expected_seeds, expected_files, read_model_sha256, overview, package_bytes, staged_at, import_seq)
    VALUES (?, ?, 'staging', 1, 'abandoned-stage', ?, 'sha256:input', NULL, ?, 'accept', 'synthetic', ?, '[]', 0, 0, 0, 1, ?, '{}', 9, ?, (SELECT COALESCE(MAX(import_seq), 0) + 1 FROM rs_results_version))`,
    STAGING, CASE, 'd'.repeat(64), now().toISOString(), `sha256:${'e'.repeat(64)}`, `sha256:${'f'.repeat(64)}`, now().toISOString());
  w.db.exec('INSERT INTO rs_package_file VALUES (?, ?, ?, ?, ?)', STAGING, 'manifest.json', 'd'.repeat(64), 9, `pkg/${'c'.repeat(64)}/${'d'.repeat(64)}`);
}
it('RED M4: an unrelated staging version is archived as staging metadata, behind live visibility, with no bytes claimed', async () => {
  const w = await setup(); abandonedStaging(w);
  const operator = w.options.nativeEvidence!.visibility!;
  w.options.nativeEvidence!.visibility = { kind: 'current-policy', async isVisible(q) { return q.resultsVersion === STAGING ? q.identity === w.identity && q.caseId === CASE : operator.isVisible(q); } };
  const d = await w.deps(), out = await exportNativeCase(d, req), m = out.manifest;
  expect(m.evidence.tables.rs_results_version!.find((v) => v.version_id === STAGING)).toMatchObject({ state: 'staging' });
  expect(m.resultsVersions.map((v) => v.version.id)).not.toContain(STAGING);
  expect(m.references.some((r) => r.resultsVersion === STAGING)).toBe(false);
  expect(await verifyNativeExport(d, { ...req, expectedManifestSha256: out.manifestSha256 })).toMatchObject({ manifestSha256: out.manifestSha256 });
  const resealed = structuredClone(m);
  resealed.evidence.tables.rs_results_version!.find((v) => v.version_id === w.current.link.candidate.resultsVersion)!.state = 'staging';
  await expect(verifyNativeExport(d, { ...req, expectedManifestSha256: await reseal(w, out.manifestKey, resealed) })).rejects.toMatchObject({ code: expect.stringMatching(/manifest-invalid|export-incomplete/) });
  w.options.nativeEvidence = { ...POLICY };
  await expect(exportNativeCase(await w.deps(), { ...req, exportId: 'publication-only' })).rejects.toMatchObject({ code: 'not-found' });
});
