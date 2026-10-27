import { afterEach, describe, expect, it } from 'vitest';
import { world, CLIENT, CASE, NOW, utf8 } from './fixture.ts';
import { createPublicationMaterialReader } from '../../../src/lib/server/runtime/hosted/publication-material.ts';
import type { CandidateSnapshot, OperationRecord, SignoffIdentity, SignoffRecord } from '../../../src/lib/publication/hosted/ports.ts';
import { originalKey, packageKey } from '../../../src/lib/storage/cloud/keys.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { checkSnapshot, signoffBlocker } from '../../../src/lib/publication/hosted/rules.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import { d1PublicationPublisher } from '../../../src/lib/publication/hosted/d1-publisher.ts';
import { d1ReadinessFence } from '../../../src/lib/publication/hosted/readiness-fence.ts';

const worlds: Awaited<ReturnType<typeof world>>[] = [];
async function setup(o?: Parameters<typeof world>[0]) { const w = await world(o); worlds.push(w); return w; }
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const snap = async (w: Awaited<ReturnType<typeof world>>) => await w.read() as CandidateSnapshot;

describe('primary D1 publication material (synthetic component evidence, NOT native renderer acceptance)', () => {
  it('derives exact validation, link, empty baseline and real chronology SSR for a distinct read-preview reviewer', async () => {
    const w = await setup();
    const s = await snap(w);
    expect(s.snapshotRevision).toMatch(/^d1:[1-9][0-9]*$/);
    expect(s.link.candidate).toEqual(w.link.candidate);
    expect(s.preparedBy.subject).toBe('preparer');
    expect(s.validation).toEqual({ verdict: w.validation.result.verdict, validatorVersion: w.validation.result.validatorVersion,
      diagnosticsSha256: w.validation.result.diagnosticsSha256, errorFingerprints: [], warningFingerprints: w.validation.result.warningFingerprints });
    expect(s.trustedBaseline).toEqual([]);
    expect(s.requiredSections).toEqual([{ key: 'chronology', state: 'valid' }]);
    expect(s.requiredPreviews).toEqual([{ assetId: 'OD-001', state: 'rendered' }]);
    expect(signoffBlocker(s)).toBeNull();
    expect(w.calls.every((c) => c === 'read-preview')).toBe(true);
    expect(w.checkerCalls[0]).toMatchObject({ clientId: CLIENT, caseId: CASE, candidateId: w.scope.candidateId,
      resultsVersion: w.rv, assetId: 'OD-001', mediaType: 'application/pdf' });
    expect(w.checkerCalls[0].bytes.slice(0, 8)).toEqual(utf8('%PDF-1.4'));
    expect(w.db.sessions.every((c) => c === 'first-primary')).toBe(true);
    expect(w.events.at(-1)?.outcome).toBe('succeeded');
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('refuses foreign-client and expired preview grants at both material and readiness observations', async () => {
    for (const mutation of ["client_id = 'foreign-client'", "expires_at = '2000-01-01T00:00:00.000Z'"]) {
      const w = await setup();
      const snapshot = await snap(w);
      const identity = w.options.identity;
      if (identity.kind !== 'verified') throw new Error('fixture identity');
      w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
        VALUES ('g-publisher', ?, 'case', ?, 'synthetic', 'distinct-reviewer', 'staff', 'publisher', 'publisher', 'active', 1, 'op-publisher', '{}', 'synthetic', 'provisioner', ?)`, CLIENT, CASE, NOW);
      const fence = d1ReadinessFence({ db: w.db, clientId: CLIENT });
      const observation = { clientId: CLIENT, caseId: CASE, principal: identity.principal, sessionId: identity.sessionId, snapshot, signoff: null };
      expect(await fence.check(observation)).toBe('current');
      w.db.exec(`UPDATE tenant_case_grants SET ${mutation} WHERE grant_id = 'g-reviewer'`);
      await expect(w.read()).rejects.toMatchObject({ code: 'forbidden' });
      expect(await fence.check(observation)).toBe('forbidden');
    }
  });

  it('uses genuine case-fold warnings without inventing original status or an empty warning list', async () => {
    const w = await setup({ fold: true, textStatus: 'none' });
    const s = await snap(w);
    expect(s.validation.verdict).toBe('report');
    expect(s.validation.warningFingerprints).toEqual(w.validation.result.warningFingerprints);
    expect(s.validation.warningFingerprints.length).toBeGreaterThan(0);
    expect(w.link.coverage.mappedOriginals[0].pathMatch).toBe('case-nfc-unique');
    expect(s.requiredPreviews[0].state).toBe('rendered');
  });

  it('does not equate valid analysis schema with hosted display support', async () => {
    const w = await setup({ section: true });
    const s = await snap(w);
    expect(s.requiredSections).toContainEqual({ key: 'risk-matrix', state: 'unsupported' });
    expect(signoffBlocker(s)?.code).toBe('required-section');
  });

  it.each(['pending', 'failed'] as const)('holds a %s checker result', async (state) => {
    const w = await setup();
    w.options.renderChecker = { async verify() { return { state, rendererVersion: 'UNIT DOUBLE', pages: null, reason: 'synthetic refusal' }; } };
    const s = await snap(w);
    expect(s.requiredPreviews[0].state).toBe(state);
    expect(signoffBlocker(s)?.code).toBe('preview-not-ready');
  });

  it('holds without an internal checker, or for a malformed rendered claim', async () => {
    const w = await setup(); w.options.renderChecker = null;
    expect((await snap(w)).requiredPreviews[0].state).toBe('pending');
    w.options.renderChecker = { async verify() { return { state: 'rendered', rendererVersion: '', pages: null, reason: null }; } };
    expect((await snap(w)).requiredPreviews[0].state).toBe('pending');
  });

  it('holds unsupported non-PDF and missing originals honestly, but still calls the checker for each PDF alias', async () => {
    const a = await setup({ mediaType: 'application/octet-stream' });
    expect((await snap(a)).requiredPreviews[0].state).toBe('pending');
    expect(a.checkerCalls).toHaveLength(0);
    const b = await setup({ missing: true, alias: true });
    const s = await snap(b);
    expect(s.requiredPreviews).toContainEqual({ assetId: 'OD-003', state: 'pending' });
    expect(b.checkerCalls.map((c) => c.assetId)).toEqual(['OD-001', 'OD-002']);
  });

  it('compares original page references with actual checker page counts and never clamps them', async () => {
    const w = await setup({ page: 2 });
    expect((await snap(w)).requiredPreviews[0].state).toBe('failed');
  });

  it('holds malformed original page references without rewriting the canonical validation', async () => {
    const w = await setup({ page: 0 });
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  });

  it('refuses all private reads before DB/object access for absent, client, wrong-client or revoked authority', async () => {
    const w = await setup();
    const beforeDb = w.db.statements, beforeObjects = w.bucket.gets;
    w.state.session = false;
    await expect(w.read()).rejects.toMatchObject({ code: 'invalid-session' });
    w.state.session = true; w.state.grant = false;
    await expect(w.read()).rejects.toMatchObject({ code: 'forbidden' });
    w.state.grant = true;
    await expect(createPublicationMaterialReader({ ...w.options, identity: { ...w.options.identity, clientId: id('client', 'client-b') } })!.read(w.scope)).rejects.toMatchObject({ code: 'wrong-client' });
    await expect(createPublicationMaterialReader({ ...w.options, identity: { ...w.options.identity, kind: 'anonymous', principal: null, sessionId: null } })!.read(w.scope)).rejects.toMatchObject({ code: 'unauthenticated' });
    if (w.options.identity.kind !== 'verified') throw new Error('fixture');
    await expect(createPublicationMaterialReader({ ...w.options, identity: { ...w.options.identity, principal: { ...w.options.identity.principal, kind: 'client' } } })!.read(w.scope)).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.db.statements).toBe(beforeDb); expect(w.bucket.gets).toBe(beforeObjects);
    expect(w.events.every((e) => e.outcome === 'denied')).toBe(true);
  });

  it('keeps unaudited and absent candidates unavailable', async () => {
    const w = await setup({ settled: false }); const before = w.bucket.gets;
    expect(await w.read()).toBeNull();
    expect(await createPublicationMaterialReader(w.options)!.read({ ...w.scope, candidateId: 'unknown' })).toBeNull();
    expect(w.bucket.gets).toBe(before);
  });

  it('requires an unsuperseded candidate both before material reads and after a renderer await', async () => {
    const a = await setup({ section: true });
    await a.supersede();
    const before = a.bucket.gets;
    expect(await a.read()).toBeNull(); expect(a.bucket.gets).toBe(before);
    const b = await setup({ section: true });
    b.options.renderChecker = { async verify() {
      await b.supersede();
      return { state: 'rendered', rendererVersion: 'UNIT DOUBLE', pages: 1, reason: null };
    } };
    await expect(b.read()).rejects.toMatchObject({ code: 'integrity' });
  });

  it.each(['grant', 'session'] as const)('rechecks %s after renderer await before release', async (key) => {
    const w = await setup();
    w.options.renderChecker = { async verify() { w.state[key] = false; return { state: 'rendered', rendererVersion: 'UNIT DOUBLE', pages: 1, reason: null }; } };
    await expect(w.read()).rejects.toMatchObject({ code: key === 'grant' ? 'forbidden' : 'invalid-session' });
  });

  it('fences a generation change during rendering, including change-and-revert', async () => {
    const w = await setup();
    w.options.renderChecker = { async verify() {
      w.db.exec('UPDATE rs_results_version SET diagnostics_sha256 = ? WHERE version_id = ?', 'sha256:' + 'a'.repeat(64), w.rv);
      w.db.exec('UPDATE rs_results_version SET diagnostics_sha256 = ? WHERE version_id = ?', w.validation.result.diagnosticsSha256, w.rv);
      return { state: 'rendered', rendererVersion: 'UNIT DOUBLE', pages: 1, reason: null };
    } };
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
    expect(w.events.some((e) => e.outcome === 'succeeded')).toBe(false);
  });

  it('checks release authority even after the final awaited material revision observation', async () => {
    const w = await setup(), session = w.db.withSession.bind(w.db);
    w.db.withSession = (constraint) => {
      if (w.events.some((e) => e.outcome === 'succeeded')) w.state.grant = false;
      return session(constraint);
    };
    await expect(w.read()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('requires the exact stored manifest and input revision pins', async () => {
    const w = await setup();
    w.db.exec('UPDATE rs_results_version SET input_revision_id = ? WHERE version_id = ?', 'another-input', w.rv);
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
    w.db.exec('UPDATE rs_results_version SET input_revision_id = ?, manifest_sha256 = ? WHERE version_id = ?',
      w.link.candidate.packageInputRevisionId, 'a'.repeat(64), w.rv);
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
    expect(w.checkerCalls).toHaveLength(0);
  });

  it('does not allow a case original binding or package file membership to drift', async () => {
    const w = await setup();
    w.db.exec('UPDATE rs_case_original SET filename = ? WHERE case_id = ?', 'Wrong.pdf', CASE);
    // Submission path, not association basename, is authoritative for finalized intake originals.
    expect((await snap(w)).requiredPreviews[0].state).toBe('rendered');
    w.db.exec('DELETE FROM rs_package_file WHERE version_id = ? AND path = ?', w.rv, 'manifest.json');
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  });

  it('fences audit awaits and refuses audit failures', async () => {
    const w = await setup(); w.state.audit = false;
    await expect(w.read()).rejects.toMatchObject({ code: 'audit-unavailable' });
    w.state.audit = true;
    w.state.auditHook = () => w.db.exec('UPDATE pub_candidate_generation SET generation = generation + 1 WHERE candidate_id = ?', w.scope.candidateId);
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  });

  it.each(['verdict', 'validator_version', 'diagnostics_sha256', 'warning_fingerprints'] as const)('compares persisted %s exactly rather than defaulting it', async (field) => {
    const w = await setup();
    const values = { verdict: 'report', validator_version: 'different', diagnostics_sha256: 'sha256:' + 'a'.repeat(64), warning_fingerprints: JSON.stringify(['b'.repeat(32)]) };
    w.db.exec(`UPDATE rs_results_version SET ${field} = ? WHERE version_id = ?`, values[field], w.rv);
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  });

  it.each(['package', 'original', 'model'] as const)('verifies exact %s integrity', async (kind) => {
    const w = await setup();
    if (kind === 'model') w.db.exec("UPDATE rs_document SET row_json = '{}' WHERE version_id = ?", w.rv);
    else {
      const key = kind === 'package' ? packageKey(w.rv, w.link.candidate.manifestSha256)
        : originalKey(w.link.coverage.mappedOriginals[0].sha256);
      w.bucket.tamper(key, (b) => { b[b.length - 1] ^= 1; return b; });
    }
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
    expect(w.checkerCalls).toHaveLength(0);
  });

  it('enforces a real verification admission budget before protected package bytes are read', async () => {
    const w = await setup(), before = w.bucket.gets;
    w.options.storageBudgets = { ...w.options.storageBudgets, maxVerifyBytes: 1 };
    await expect(w.read()).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(w.bucket.gets - before).toBe(1); // the bounded storage identity object, not package/original bytes
    expect(w.checkerCalls).toHaveLength(0);
  });

  it('admits the combined package, original verification and rendering-read plan, not separate per-phase maxima', async () => {
    const w = await setup(), before = w.bucket.gets;
    const files = w.db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM rs_package_file WHERE version_id = ?', w.rv)[0].n;
    w.options.storageBudgets = { ...w.options.storageBudgets, maxVerifyObjects: files + 1 };
    await expect(w.read()).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(w.bucket.gets - before).toBe(1);
  });

  it('atomically bounds two readers by the shared verification window and admits a later window', async () => {
    const w = await setup();
    const files = w.db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM rs_package_file WHERE version_id = ?', w.rv)[0].n;
    const plan = files + 2;
    w.options.storageBudgets = { ...w.options.storageBudgets, maxVerifyObjects: plan, maxVerifyObjectsPerCaseWindow: plan };
    const results = await Promise.allSettled([w.read(), w.read()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected?.status !== 'rejected') throw new Error('fixture');
    expect(rejected.reason).toMatchObject({ code: 'storage-unavailable' });
    w.options.now = () => new Date(Date.parse(NOW) + w.options.storageBudgets.verifyWindowSeconds * 1000);
    expect((await snap(w)).requiredPreviews[0].state).toBe('rendered');
  });

  it('fences a current baseline change across a checker await', async () => {
    const w = await setup();
    w.options.renderChecker = { async verify() {
      w.db.exec('INSERT INTO rs_trusted_fingerprint VALUES (?, ?)', CASE, 'a'.repeat(32));
      return { state: 'rendered', rendererVersion: 'UNIT DOUBLE', pages: 1, reason: null };
    } };
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  });

  it('requires every configured validation and storage bound, with no defaults', async () => {
    const w = await setup();
    expect(createPublicationMaterialReader({ ...w.options, validationLimits: { ...w.options.validationLimits, assets: 0 } })).toBeNull();
    expect(createPublicationMaterialReader({ ...w.options, storageBudgets: { ...w.options.storageBudgets, maxPackageBytes: 0 } })).toBeNull();
  });

  it('rejects crossed DB/bucket identity and does not take baseline warnings from a package or orphan table row', async () => {
    const w = await setup();
    w.bucket.setRaw('identity/client.json', utf8('{"client_id":"client-b"}'));
    await expect(w.read()).rejects.toMatchObject({ code: 'storage-unavailable' });
    w.bucket.setRaw('identity/client.json', utf8(JSON.stringify({ client_id: CLIENT })));
    w.db.exec('INSERT INTO rs_trusted_fingerprint VALUES (?, ?)', CASE, 'a'.repeat(32));
    await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  });

  it('reads the genuine audited current published warning baseline, not an invented empty set', async () => {
    const w = await setup({ textStatus: 'none' });
    const snapshot = await snap(w), ledger = d1PublicationLedger(w.db);
    if (w.options.identity.kind !== 'verified') throw new Error('fixture');
    const who = w.options.identity;
    // Explicit publisher grant is only for the atomic publish fixture. The material reader itself never asks for operate.
    w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot,
      state, expires_at, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
      VALUES ('pub-grant', ?, 'case', ?, ?, ?, 'staff', 'publisher', 'publisher', 'active', NULL, 1, 'grant-op', '{}', ?, ?, ?)`,
      CLIENT, CASE, who.principal.issuer, who.principal.subject, who.principal.issuer, who.principal.subject, NOW);
    const publisher = d1PublicationPublisher({ db: w.db, clientId: CLIENT, checkSession: async () => {} });
    // The integrated guard now accepts the genuine tagged digest without altering the material identity.
    // Keep the real ledger/atomic baseline checks below; this is still not native acceptance evidence.
    expect(snapshot.validation.diagnosticsSha256).toMatch(/^sha256:/);
    expect(checkSnapshot(snapshot)).toEqual(snapshot);
    const identity: SignoffIdentity = { candidateId: w.scope.candidateId, linkId: snapshot.link.linkId,
      submissionRevisionId: snapshot.link.submissionRevisionId, submissionManifestSha256: snapshot.link.submissionManifestSha256,
      resultsVersion: w.rv, manifestSha256: snapshot.link.candidate.manifestSha256, packageInputRevisionId: snapshot.link.candidate.packageInputRevisionId,
      diagnosticsSha256: snapshot.validation.diagnosticsSha256, validatorVersion: snapshot.validation.validatorVersion, snapshotRevision: snapshot.snapshotRevision };
    const signed: SignoffRecord = { ...identity, signoffId: 'so-synthetic-signoff-0001', operationId: 'synthetic-signoff-0001',
      requestSha256: 'a'.repeat(64), clientId: CLIENT, caseId: CASE, warningFingerprints: snapshot.validation.warningFingerprints,
      acknowledgements: snapshot.validation.warningFingerprints.map((fingerprint) => ({ fingerprint, reason: 'Reviewed synthetic warning' })),
      signer: who.principal, preparedBy: snapshot.preparedBy, selfApproval: false, signedAt: NOW, state: 'recorded', invalidatedAt: null, invalidatedReason: null,
      auditEvent: { eventId: 'synthetic-signoff-audit', actor: { kind: 'verified', principal: who.principal, sessionId: who.sessionId },
        action: 'publication.signoff', object: { kind: 'publication', id: 'so-synthetic-signoff-0001', caseId: CASE }, version: w.rv, outcome: 'succeeded', at: NOW } };
    expect((await ledger.recordSignoff(signed)).kind).toBe('recorded');
    await w.options.audit.append(signed.auditEvent);
    await ledger.settleSignoff({ ...w.scope, signoffId: signed.signoffId });
    const operation: OperationRecord = { operationId: 'synthetic-publish-0001', requestSha256: 'b'.repeat(64), clientId: CLIENT, caseId: CASE,
      kind: 'publish', signoffId: signed.signoffId, resultsVersion: w.rv, expected: { kind: 'none' }, actor: who.principal,
      signedIdentity: identity, state: 'pending', reason: null, at: NOW,
      auditEvent: { ...signed.auditEvent, eventId: 'synthetic-publish-audit', action: 'publication.publish', object: { kind: 'publication', id: 'synthetic-publish-0001', caseId: CASE } } };
    await ledger.beginOperation(operation);
    const { state: _state, reason: _reason, ...intent } = operation;
    expect((await publisher.publish({ intent, authority: { ...w.scope, principal: who.principal, sessionId: who.sessionId, capability: 'publish' }, recheck: async () => {} })).kind).toBe('applied');
    await ledger.finishOperation({ ...w.scope, operationId: operation.operationId, state: 'applied', reason: null });
    await w.options.audit.append(operation.auditEvent);
    await ledger.settleOperation({ ...w.scope, operationId: operation.operationId });
    const current = await snap(w);
    expect(current.trustedBaseline).toEqual(snapshot.validation.warningFingerprints);
    expect(current.trustedBaseline.length).toBeGreaterThan(0);
  });
});
