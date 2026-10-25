import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNativePublication } from '../../../../src/lib/publication/hosted/controller.ts';
import { d1PublicationLedger } from '../../../../src/lib/publication/hosted/ledger.ts';
import { d1PublicationPublisher, d1PublicationSnapshotRevision } from '../../../../src/lib/publication/hosted/d1-publisher.ts';
import type { PublicationIntent, SignoffIdentity } from '../../../../src/lib/publication/hosted/ports.ts';
import { id } from '../../../../src/lib/server/runtime/ids.ts';
import { CASE, CLIENT, Harness, NOW, OTHER_CASE, PRINCIPAL, SESSION, error, hash, insert, version } from './harness.ts';
import { FileD1 } from './sqlite.ts';

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(() => h.close());
const key = (intent: PublicationIntent) => ({ clientId: CLIENT, caseId: CASE, operationId: intent.operationId });
const request = (body: unknown, sessionId = SESSION) => {
  const url = new URL('https://client.test/operator/publication/case-a/publish');
  return { request: new Request(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, params: { caseId: CASE }, identity: h.identity(sessionId) };
};

it('publishes the exact signed identity with an immutable operation receipt in the pointer transaction', async () => {
  const intent = await h.operation(await h.signed());
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'applied', repeated: false });
  expect(h.pointer()).toMatchObject({ state: 'published', version_id: intent.resultsVersion });
  expect(await h.publisher.receipt(key(intent))).toEqual({ intent });
  expect(h.checks).toEqual([h.mutation(intent).authority]);
  expect(h.db.sessions.every((s) => s === 'first-primary')).toBe(true);
  expect(h.db.rows('PRAGMA foreign_key_check')).toEqual([]);
});

it('withdraws results with its own receipt, preserving versions, originals, previews and Keep', async () => {
  const candidateId = h.candidate();
  insert(h.db, 'rs_preview', { version_id: version('1'), asset_id: 'asset-1', sha256: hash('c'), size: 0, media_type: 'application/pdf', filename: 'synthetic.pdf', object_key: 'preview/synthetic' });
  const intent = await h.operation(await h.signed(candidateId)); await h.publisher.publish(h.mutation(intent));
  h.db.exec('UPDATE rs_results_version SET keep = 1 WHERE version_id = ?', intent.resultsVersion);
  insert(h.db, 'rs_original', { sha256: hash('f'), size: 5, object_key: 'orig/synthetic' });
  const withdrawal = await h.withdrawal(intent.resultsVersion);
  expect(await h.publisher.withdraw(h.mutation(withdrawal))).toEqual({ kind: 'applied', repeated: false });
  expect(h.pointer()).toMatchObject({ state: 'withdrawn', version_id: intent.resultsVersion });
  expect(h.db.rows('SELECT * FROM rs_version_withdrawal')).toHaveLength(1);
  expect(h.db.rows('SELECT keep FROM rs_results_version')[0]).toEqual({ keep: 1 });
  expect(h.db.rows('SELECT * FROM rs_original')).toHaveLength(1);
  expect(h.db.rows('SELECT * FROM rs_preview')).toHaveLength(1);
  expect(h.receiptCount()).toBe(2);
  expect(await h.publisher.receipt(key(withdrawal))).toEqual({ intent: withdrawal });
});

for (const kind of ['publish', 'withdraw'] as const) describe(kind, () => {
  async function intentForKind() {
    const publish = await h.operation(await h.signed());
    if (kind === 'publish') return publish;
    await h.publisher.publish(h.mutation(publish)); return h.withdrawal(publish.resultsVersion);
  }
  it('propagates a recheck rejection unchanged and does not write a receipt', async () => {
    const intent = await intentForKind(), before = h.pointer(), count = h.receiptCount(), refusal = { controller: 'Refusal' };
    await expect(h.publisher[kind](h.mutation(intent, async () => { throw refusal; }))).rejects.toBe(refusal);
    expect(h.pointer()).toEqual(before); expect(h.receiptCount()).toBe(count);
  });
  it('runs the current session check LAST and denies observed external revocation', async () => {
    const intent = await intentForKind(), before = h.pointer(), count = h.receiptCount(), denial = error('invalid-session');
    expect(await h.publisher[kind](h.mutation(intent, async () => { h.sessionError = denial; }))).toEqual({ kind: 'guard-refused', reason: 'invalid-session' });
    expect(h.pointer()).toEqual(before); expect(h.receiptCount()).toBe(count);
  });
  it('serializes a grant revocation after the async recheck and final session check', async () => {
    const intent = await intentForKind(), before = h.pointer(), count = h.receiptCount();
    h.db.beforeBatch = () => h.revoke();
    expect(await h.publisher[kind](h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'forbidden' });
    expect(h.pointer()).toEqual(before); expect(h.receiptCount()).toBe(count);
  });
  it('serializes a locally observed session revocation after the external check', async () => {
    const intent = await intentForKind(), before = h.pointer(), count = h.receiptCount();
    h.db.beforeBatch = () => insert(h.editor, 'pub_session_revocation', { client_id: CLIENT, issuer: PRINCIPAL.issuer, session_id: SESSION, revoked_at: NOW });
    expect(await h.publisher[kind](h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'invalid-session' });
    expect(h.pointer()).toEqual(before); expect(h.receiptCount()).toBe(count);
  });
});

it.each([
  ['pending', "UPDATE tenant_case_grants SET state = 'pending'"],
  ['expired', "UPDATE tenant_case_grants SET expires_at = '2000-01-01T00:00:00.000Z'"],
  ['bad expiry', "UPDATE tenant_case_grants SET expires_at = 'not-a-date'"],
  ['other case', `UPDATE tenant_case_grants SET case_id = '${OTHER_CASE}'`],
  ['other client', "UPDATE tenant_case_grants SET client_id = 'client-b'"],
  ['other issuer', "UPDATE tenant_case_grants SET issuer = 'https://other.test'"],
  ['other subject', "UPDATE tenant_case_grants SET subject = 'someone-else'"],
  ['other kind', "UPDATE tenant_case_grants SET principal_kind = 'client'"],
  ['operator not publisher', "UPDATE tenant_case_grants SET role = 'operator', slot = 'operator'"],
])('requires a CURRENT explicit case publish grant: %s', async (_label, sql) => {
  const intent = await h.operation(await h.signed()); h.editor.exec(sql);
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'forbidden' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('requires audited non-invalidated sign-off even when recheck is a no-op', async () => {
  const signed = await h.signed(), intent = await h.operation(signed);
  await h.ledger.invalidateSignoff({ clientId: CLIENT, caseId: CASE, signoffId: signed.signoffId, at: NOW, reason: 'review changed' });
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('rejects an unaudited sign-off even when all its identities match', async () => {
  const signed = await h.signed(h.candidate(), 'signoff-recorded-0001', false), intent = await h.operation(signed);
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('requires settled candidate provenance, matching the candidate owner’s durable current predicate', async () => {
  const candidateId = h.candidate('1', null, false);
  expect(await d1PublicationSnapshotRevision(h.db, { clientId: CLIENT, caseId: CASE, candidateId })).toBeNull();
  // Adverse fixture: even a wrongly recorded effective sign-off must not override a noncurrent candidate.
  const intent = await h.operation(await h.signed(candidateId, 'signoff-unaudited-candidate', true, 'd1:1'));
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('requires every field of the signed identity, not merely resultsVersion', async () => {
  const signed = await h.signed();
  for (const field of Object.keys(signed.identity) as (keyof SignoffIdentity)[]) {
    const intent = await h.operation(signed, `publish-identity-${field}-0001`);
    // Persist a DIFFERENT legitimate immutable intent, not just a mismatched caller parameter.
    const operationId = `${intent.operationId}-x`;
    const altered = { ...intent, operationId, signedIdentity: { ...signed.identity, [field]: 'changed' } };
    await h.ledger.beginOperation({ ...altered, state: 'pending', reason: null });
    expect(await h.publisher.publish(h.mutation(altered))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  }
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('durably invalidates after edit AND reversion before commit, preserving the old pointer', async () => {
  const old = await h.operation(await h.signed()); await h.publisher.publish(h.mutation(old));
  const next = await h.operation(await h.signed(h.candidate('2'), 'signoff-operation-0002'), 'publish-operation-0002', { kind: 'published', resultsVersion: old.resultsVersion });
  h.db.beforeBatch = () => {
    h.editor.exec("UPDATE rs_results_version SET overview = '{\"changed\":true}' WHERE version_id = ?", next.resultsVersion);
    h.editor.exec("UPDATE rs_results_version SET overview = '{}' WHERE version_id = ?", next.resultsVersion);
  };
  expect(await h.publisher.publish(h.mutation(next))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(h.pointer()?.version_id).toBe(old.resultsVersion); expect(h.receiptCount()).toBe(1);
  expect((await h.ledger.signoff({ clientId: CLIENT, caseId: CASE, signoffId: next.signoffId! }))?.invalidatedReason).toBe('candidate-dependency-changed');
  expect(await d1PublicationSnapshotRevision(h.db, { clientId: CLIENT, caseId: CASE, candidateId: next.signedIdentity!.candidateId })).toBe('d1:3');
});

it('supersession is an atomic invalidation even if publication is subsequently refused', async () => {
  const signed = await h.signed(), intent = await h.operation(signed), correction = h.candidate('2', signed.identity.candidateId);
  h.db.beforeBatch = () => h.supersede(signed.identity.candidateId, correction);
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(await d1PublicationSnapshotRevision(h.db, { clientId: CLIENT, caseId: CASE, candidateId: signed.identity.candidateId })).toBeNull();
  expect((await h.ledger.signoff({ clientId: CLIENT, caseId: CASE, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it.each([
  ['rs_package_file', { path: 'case.json', sha256: hash('a'), size: 0, object_key: 'package/synthetic' }],
  ['rs_document', { ref: 'ref-1', ord: 0, row_json: '{}', state_json: '{}', list_json: '{}', attachments_json: '[]' }],
  ['rs_asset', { asset_key: 'asset-1', row_json: '{}' }],
  ['rs_seed', { ord: 0, dataset_key: 'notes', seed_id: 'seed-1', seed_sha256: hash('b'), record_json: '{}' }],
  ['rs_preview', { asset_id: 'asset-1', sha256: hash('c'), size: 0, media_type: 'application/pdf', filename: 'synthetic.pdf', object_key: 'preview/synthetic' }],
] as const)('tracks insert/update/delete and REPLACE dependencies in %s', async (table, fields) => {
  const signed = await h.signed(), rv = signed.identity.resultsVersion;
  const revision = () => d1PublicationSnapshotRevision(h.db, { clientId: CLIENT, caseId: CASE, candidateId: signed.identity.candidateId });
  insert(h.editor, table, { version_id: rv, ...fields }); expect(await revision()).toBe('d1:2');
  h.editor.exec(`UPDATE ${table} SET version_id = version_id WHERE version_id = ?`, rv); expect(await revision()).toBe('d1:3');
  const columns = ['version_id', ...Object.keys(fields)], values = [rv, ...Object.values(fields)];
  h.editor.exec(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...values); expect(await revision()).toBe('d1:4');
  h.editor.exec(`DELETE FROM ${table} WHERE version_id = ?`, rv); expect(await revision()).toBe('d1:5');
  expect((await h.ledger.signoff({ clientId: CLIENT, caseId: CASE, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
});

it('a results-version REPLACE cannot evade dependency invalidation with recursive_triggers off', async () => {
  const signed = await h.signed(), intent = await h.operation(signed);
  expect(h.db.rows('PRAGMA recursive_triggers')[0]).toEqual({ recursive_triggers: 0 });
  h.db.beforeBatch = () => h.editor.exec('INSERT OR REPLACE INTO rs_results_version SELECT * FROM rs_results_version WHERE version_id = ?', intent.resultsVersion);
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('original mappings and metadata changes invalidate signatures without touching the results pointer', async () => {
  const signed = await h.signed(), intent = await h.operation(signed);
  insert(h.db, 'rs_original', { sha256: hash('a'), size: 0, object_key: 'orig/synthetic' });
  insert(h.db, 'rs_case_original', { case_id: CASE, asset_id: 'asset-1', sha256: hash('a'), filename: 'synthetic.pdf', media_type: 'application/pdf', finalized_at: NOW });
  const revision = () => d1PublicationSnapshotRevision(h.db, { clientId: CLIENT, caseId: CASE, candidateId: signed.identity.candidateId });
  expect(await revision()).toBe('d1:2');
  h.editor.exec('UPDATE rs_original SET size = 1 WHERE sha256 = ?', hash('a')); expect(await revision()).toBe('d1:3');
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('rolls back pointer, baseline and receipt on an injected failure after the receipt INSERT', async () => {
  const intent = await h.operation(await h.signed());
  insert(h.db, 'rs_trusted_fingerprint', { case_id: CASE, fingerprint: 'f'.repeat(32) });
  h.db.afterStatement = (index) => { if (index === 0) throw new Error('power loss before commit'); };
  await expect(h.publisher.publish(h.mutation(intent))).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
  expect(h.db.rows('SELECT * FROM rs_trusted_fingerprint')).toEqual([{ case_id: CASE, fingerprint: 'f'.repeat(32) }]);
  h.db.afterStatement = null;
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'applied', repeated: false });
});

it('a conflict neither writes a receipt nor infers application from equal pointer values', async () => {
  const signed = await h.signed(), first = await h.operation(signed);
  await h.publisher.publish(h.mutation(first));
  const conflicting = await h.operation(signed, 'publish-operation-conflict');
  expect(await h.publisher.publish(h.mutation(conflicting))).toEqual({ kind: 'conflict', current: { kind: 'published', resultsVersion: first.resultsVersion } });
  expect(await h.publisher.receipt(key(conflicting))).toBeNull();
  const samePointer = await h.operation(signed, 'publish-operation-noop-001', { kind: 'published', resultsVersion: first.resultsVersion });
  expect(await h.publisher.publish(h.mutation(samePointer))).toEqual({ kind: 'applied', repeated: false });
  expect(await h.publisher.receipt(key(samePointer))).toEqual({ intent: samePointer });
});

it('rejects intent reuse, forged envelopes, wrong actor and wrong client without mutation', async () => {
  const intent = await h.operation(await h.signed());
  for (const forged of [{ ...intent, requestSha256: hash('f') }, { ...intent, auditEvent: { ...intent.auditEvent, at: '2000-01-01T00:00:00Z' } }, { ...intent, at: 'different' }])
    expect(await h.publisher.publish(h.mutation(forged))).toEqual({ kind: 'refused', reason: 'intent-mismatch' });
  const original = h.mutation(intent), mutation = { ...original, authority: { ...original.authority, principal: { ...PRINCIPAL, subject: 'other-actor' } } };
  expect(await h.publisher.publish(mutation)).toEqual({ kind: 'guard-refused', reason: 'forbidden' });
  h.editor.exec("UPDATE rs_storage_identity SET client_id = 'client-b'");
  expect(await h.publisher.publish(h.mutation(intent))).toEqual({ kind: 'guard-refused', reason: 'forbidden' });
  expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('receipt DELETE, UPDATE, REPLACE and IGNORE cannot change historical identity', async () => {
  const intent = await h.operation(await h.signed()); await h.publisher.publish(h.mutation(intent));
  const original = h.db.rows('SELECT * FROM pub_apply_receipt')[0];
  for (const sql of ["UPDATE pub_apply_receipt SET intent_json = '{}'", 'DELETE FROM pub_apply_receipt',
    'INSERT OR REPLACE INTO pub_apply_receipt SELECT * FROM pub_apply_receipt', 'INSERT OR IGNORE INTO pub_apply_receipt SELECT * FROM pub_apply_receipt']) expect(() => h.editor.exec(sql)).toThrow();
  expect(h.db.rows('SELECT * FROM pub_apply_receipt')).toEqual([original]);
  expect(() => h.editor.exec('UPDATE pub_candidate_generation SET generation = generation - 1')).toThrow();
  expect(() => h.editor.exec('DELETE FROM pub_candidate_generation')).toThrow();
});

it('two independent connections competing for one expected pointer produce one receipt and one conflict', async () => {
  const signed = await h.signed(), first = await h.operation(signed);
  const actor = { ...PRINCIPAL, subject: 'publisher-2' }; h.grant(actor, 'publisher', CASE, 'grant-publisher-2');
  const second: PublicationIntent = { ...first, operationId: 'publish-operation-0002', actor,
    auditEvent: { ...first.auditEvent, eventId: 'publish-operation-0002', actor: { kind: 'verified', principal: actor, sessionId: id('session', 'sess-publisher-0002') } } };
  await h.ledger.beginOperation({ ...second, state: 'pending', reason: null });
  const peer = h.makePublisher(h.editor), mutation = h.mutation(second);
  const outcomes = await Promise.all([h.publisher.publish(h.mutation(first)), peer.publish({ ...mutation, authority: { ...mutation.authority, principal: actor, sessionId: id('session', 'sess-publisher-0002') } })]);
  expect(outcomes.map((o) => o.kind).sort()).toEqual(['applied', 'conflict']); expect(h.receiptCount()).toBe(1);
});

it('two independent connections retrying the SAME operation apply it only once', async () => {
  const intent = await h.operation(await h.signed());
  const outcomes = await Promise.all([h.publisher.publish(h.mutation(intent)), h.makePublisher(h.editor).publish(h.mutation(intent))]);
  expect(outcomes).toEqual([{ kind: 'applied', repeated: false }, { kind: 'applied', repeated: true }]); expect(h.receiptCount()).toBe(1);
});

it('recovers exact receipt after lost acknowledgement, restart, edits, withdrawal and a later publication', async () => {
  const signed = await h.signed(), intent = await h.operation(signed);
  h.db.loseAcknowledgement = true;
  await expect(h.publisher.publish(h.mutation(intent))).rejects.toThrow('injected lost readback');
  h.db.failReads = false;
  const restarted = new FileD1(h.path), publisher = h.makePublisher(restarted);
  try {
    const stored = restarted.rows('SELECT * FROM pub_apply_receipt')[0];
    h.editor.exec("UPDATE rs_results_version SET overview = '{\"edited\":true}' WHERE version_id = ?", intent.resultsVersion);
    const withdrawal = await h.withdrawal(intent.resultsVersion); await publisher.withdraw(h.mutation(withdrawal));
    const later = await h.operation(await h.signed(h.candidate('2'), 'signoff-operation-0002'), 'publish-operation-0002', { kind: 'withdrawn', resultsVersion: intent.resultsVersion });
    await publisher.publish(h.mutation(later));
    const retry = id('session', 'sess-retry-0002');
    expect(await publisher.publish(h.mutation(intent, async () => { throw new Error('must not rejudge candidate'); }, retry))).toEqual({ kind: 'applied', repeated: true });
    expect(await publisher.receipt(key(intent))).toEqual({ intent }); expect(h.pointer()?.version_id).toBe(later.resultsVersion);
    expect(restarted.rows('SELECT * FROM pub_apply_receipt WHERE operation_id = ?', intent.operationId)).toEqual([stored]);
  } finally { restarted.close(); }
});

it('real controller recovers a failed ledger outcome across sessions using the original historical audit envelope', async () => {
  const signed = await h.signed(), operationId = 'controller-publish-0001';
  const controller = createNativePublication(h.ports());
  h.db.failSql = /UPDATE pub_operation SET state = \?/;
  const body = { operationId, signoffId: signed.signoffId, expected: { kind: 'none' } };
  expect((await controller.publish(request(body))).status).toBe(503);
  expect(h.pointer()?.state).toBe('published'); expect(h.receiptCount()).toBe(1);
  const receipt = (await h.publisher.receipt({ clientId: CLIENT, caseId: CASE, operationId }))!;
  expect((await h.ledger.operation({ clientId: CLIENT, caseId: CASE, operationId }))?.state).toBe('pending');
  h.editor.exec("UPDATE rs_results_version SET overview = '{\"changed\":true}' WHERE version_id = ?", signed.identity.resultsVersion);
  const later = await h.operation(await h.signed(h.candidate('2'), 'signoff-operation-0002'), 'publish-operation-0002', { kind: 'published', resultsVersion: signed.identity.resultsVersion });
  await h.publisher.publish(h.mutation(later));
  const restart = new FileD1(h.path);
  try {
    const retryController = createNativePublication({ ...h.ports(), publisher: h.makePublisher(restart), ledger: d1PublicationLedger(restart) });
    expect((await retryController.publish(request(body, id('session', 'sess-retry-0002')))).status).toBe(200);
    expect(h.events).toEqual([receipt.intent.auditEvent]); expect(h.pointer()?.version_id).toBe(later.resultsVersion);
    expect((await h.ledger.operation({ clientId: CLIENT, caseId: CASE, operationId }))?.state).toBe('audited');
  } finally { restart.close(); }
});

it('the real controller maps a last-moment session denial to 401, not a storage failure', async () => {
  const signed = await h.signed();
  const publisher = d1PublicationPublisher({ db: h.db, clientId: CLIENT, checkSession: async () => { throw error('invalid-session'); } });
  const controller = createNativePublication({ ...h.ports(), publisher });
  const response = await controller.publish(request({ operationId: 'controller-denied-0001', signoffId: signed.signoffId, expected: { kind: 'none' } }));
  expect(response.status).toBe(401); expect(h.pointer()).toBeNull(); expect(h.receiptCount()).toBe(0);
});

it('keeps the unavoidable external Clerk race explicit: a non-observed revocation cannot be locked by SQLite', async () => {
  const intent = await h.operation(await h.signed()); let externalRevoked = false;
  const publisher = d1PublicationPublisher({ db: h.db, clientId: CLIENT, checkSession: async () => { if (externalRevoked) throw error('invalid-session'); } });
  h.db.beforeBatch = () => { externalRevoked = true; }; // External change AFTER last successful authoritative response.
  expect(await publisher.publish(h.mutation(intent))).toEqual({ kind: 'applied', repeated: false });
  // This is a bounded consistency guarantee, deliberately NOT a fake globally atomic Clerk/D1 success claim.
});
