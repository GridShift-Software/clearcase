// Real synthetic SQL, intake, ledger and material-reader regressions; no native/provider acceptance.
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { world, CASE, CLIENT, NOW } from './fixture.ts';
import { approve, type World } from './signoff-fixture.ts';
import type { OperationRecord, SignoffIdentity } from '../../../src/lib/publication/hosted/ports.ts';
import { d1PublicationPublisher, d1PublicationSnapshotRevision } from '../../../src/lib/publication/hosted/d1-publisher.ts';
import { d1SubmissionRepository } from '../../../src/lib/submissions/repository.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';

const worlds: World[] = [];
async function setup(o?: Parameters<typeof world>[0]) { const w = await world(o); worlds.push(w); return w; }
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const generation = (w: World) => w.db.rows<{ generation: number }>('SELECT generation FROM pub_candidate_generation WHERE candidate_id = ?', w.scope.candidateId)[0].generation;
type Row = Record<string, string | number | null>;
function insert(w: World, table: string, row: Row, replace = false) {
  const keys = Object.keys(row);
  w.db.exec(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
}

it.each(['renderer', 'audit'] as const)('fences original provenance ABA during the final %s await and permanently invalidates approval', async (phase) => {
  const w = await setup(), { ledger, signed } = await approve(w), before = generation(w);
  const change = () => {
    w.db.exec("UPDATE rs_original_upload SET state = 'stored' WHERE case_id = ?", CASE);
    w.db.exec("UPDATE rs_original_upload SET state = 'finalized' WHERE case_id = ?", CASE);
  };
  if (phase === 'renderer') w.options.renderChecker = { async verify() {
    change(); return { state: 'rendered', rendererVersion: 'EXPLICIT UNIT DOUBLE', pages: 1, reason: null };
  } };
  else w.state.auditHook = (e) => { if (e.outcome === 'succeeded') change(); };
  await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  expect(generation(w)).toBeGreaterThan(before);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedReason).toBe('candidate-dependency-changed');
  expect(w.events.at(-1)?.outcome).toBe('failed');
});

it.each(['state', 'asset_id', 'sha256', 'size', 'case_id', 'operation_id'] as const)('fences original-upload %s association changes, including revert', async (field) => {
  const w = await setup(), { ledger, signed } = await approve(w), old = w.db.rows<Row>('SELECT * FROM rs_original_upload')[0];
  w.db.exec("INSERT INTO rs_case VALUES ('case-other', 'Synthetic other case')");
  const changed = { state: 'stored', asset_id: 'different-asset', sha256: 'b'.repeat(64), size: 1, case_id: 'case-other', operation_id: 'different-operation' }[field];
  const before = generation(w);
  w.db.exec(`UPDATE rs_original_upload SET ${field} = ?`, changed);
  w.db.exec(`UPDATE rs_original_upload SET ${field} = ?`, old[field]);
  expect(generation(w)).toBeGreaterThan(before);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
});

it.each(['rs_original_upload', 'rs_case_original', 'rs_trusted_fingerprint', 'rs_publication', 'rs_version_withdrawal', 'rs_storage_identity'] as const)(
  'fences INSERT, UPDATE, DELETE and REPLACE of %s without recursive delete triggers', async (table) => {
    const w = await setup();
    expect(w.db.rows<{ recursive_triggers: number }>('PRAGMA recursive_triggers')[0].recursive_triggers).toBe(0);
    const rows: Record<typeof table, Row> = {
      rs_original_upload: { ...w.db.rows<Row>('SELECT * FROM rs_original_upload')[0], operation_id: 'another-upload' },
      rs_case_original: { ...w.db.rows<Row>('SELECT * FROM rs_case_original')[0], asset_id: 'another-association' },
      rs_trusted_fingerprint: { case_id: CASE, fingerprint: 'a'.repeat(32) },
      rs_publication: { case_id: CASE, state: 'published', version_id: w.rv, previous_version_id: null },
      rs_version_withdrawal: { case_id: CASE, version_id: w.rv, withdrawn_at: NOW },
      rs_storage_identity: { singleton: 1, client_id: CLIENT, layout: 'clearcase.rs/1' },
    };
    const row = rows[table];
    if (table === 'rs_storage_identity') w.db.exec('DELETE FROM rs_storage_identity');
    let before = generation(w);
    insert(w, table, row);
    expect(generation(w)).toBeGreaterThan(before);
    before = generation(w);
    const key = Object.keys(row)[0];
    w.db.exec(`UPDATE ${table} SET ${key} = ${key}`);
    expect(generation(w)).toBeGreaterThan(before);
    before = generation(w);
    insert(w, table, row, true);
    expect(generation(w)).toBeGreaterThan(before);
    before = generation(w);
    w.db.exec(`DELETE FROM ${table}`);
    expect(generation(w)).toBeGreaterThan(before);
  },
);

it('fences original REPLACE conflict victims on the secondary object-key uniqueness constraint', async () => {
  const w = await setup(), before = generation(w);
  // Preserve the SHA primary key while replacing its metadata: works with foreign keys ON.
  const original = w.db.rows<Row>('SELECT * FROM rs_original')[0];
  insert(w, 'rs_original', { ...original, size: 1 }, true);
  expect(generation(w)).toBeGreaterThan(before);
  // A different SHA attempting to evict this referenced original is refused by its foreign key.
  const after = generation(w);
  expect(() => insert(w, 'rs_original', { ...original, sha256: 'b'.repeat(64) }, true)).toThrow();
  expect(generation(w)).toBe(after);
  expect(w.db.rows<Row>('SELECT * FROM rs_original')[0].sha256).toBe(original.sha256);
});

it.each(['submissions_upload', 'submissions_revision', 'submissions_file'] as const)('retains immutable finalized %s against path/link UPDATE, DELETE and REPLACE', async (table) => {
  const w = await setup(), { ledger, signed } = await approve(w), row = w.db.rows<Row>(`SELECT * FROM ${table}`)[0], before = generation(w);
  const field = table === 'submissions_revision' ? 'operation_id' : 'path';
  expect(() => w.db.exec(`UPDATE ${table} SET ${field} = 'changed'`)).toThrow();
  expect(() => w.db.exec(`DELETE FROM ${table}`)).toThrow();
  expect(() => insert(w, table, row, true)).toThrow();
  expect(generation(w)).toBe(before);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).toBeNull();
});

it('fences legal mutable submission metadata, including ABA, without rewriting the finalized path', async () => {
  const w = await setup(), { ledger, signed } = await approve(w), before = generation(w);
  w.db.exec("UPDATE submissions_upload SET stored_at = '2026-10-25T10:00:00.000Z'");
  w.db.exec('UPDATE submissions_upload SET stored_at = ?', NOW);
  expect(generation(w)).toBeGreaterThan(before);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
});

it.each(['renderer', 'audit'] as const)('fences warning-baseline insert/delete ABA during %s work', async (phase) => {
  const w = await setup(), { ledger, signed } = await approve(w), before = generation(w);
  const change = () => {
    w.db.exec('INSERT INTO rs_trusted_fingerprint VALUES (?, ?)', CASE, 'a'.repeat(32));
    w.db.exec('DELETE FROM rs_trusted_fingerprint WHERE case_id = ?', CASE);
  };
  if (phase === 'renderer') w.options.renderChecker = { async verify() {
    change(); return { state: 'rendered', rendererVersion: 'EXPLICIT UNIT DOUBLE', pages: 1, reason: null };
  } };
  else w.state.auditHook = (e) => { if (e.outcome === 'succeeded') change(); };
  await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  expect(generation(w)).toBeGreaterThan(before);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
});

it('fences baseline-version metadata even when it belongs to a different candidate/version', async () => {
  const w = await setup(), before = generation(w), row = w.db.rows<Row>('SELECT * FROM rs_results_version')[0];
  const other = { ...row, version_id: 'sha256:' + 'b'.repeat(64), import_seq: 2 };
  insert(w, 'rs_results_version', other);
  const inserted = generation(w);
  expect(inserted).toBeGreaterThan(before);
  w.db.exec('UPDATE rs_results_version SET warning_fingerprints = ? WHERE version_id = ?', '["' + 'a'.repeat(32) + '"]', other.version_id);
  expect(generation(w)).toBeGreaterThan(inserted);
});

it('fences a cross-case results-version REPLACE victim on the import-sequence unique key', async () => {
  const w = await setup(), row = w.db.rows<Row>('SELECT * FROM rs_results_version')[0];
  const sibling = { ...row, version_id: 'sha256:' + 'b'.repeat(64), import_seq: 2 };
  insert(w, 'rs_results_version', sibling);
  const { ledger, signed } = await approve(w), before = generation(w);
  w.db.exec("INSERT INTO rs_case VALUES ('case-other', 'Synthetic other case')");
  insert(w, 'rs_results_version', { ...sibling, case_id: 'case-other', version_id: 'sha256:' + 'c'.repeat(64) }, true);
  expect(w.db.rows<Row>('SELECT * FROM rs_results_version WHERE version_id = ?', sibling.version_id)).toEqual([]);
  expect(generation(w)).toBeGreaterThan(before);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
});

it('refuses the real atomic publisher after provenance changes and reverts following material release', async () => {
  const w = await setup(), { ledger, signed } = await approve(w);
  if (w.options.identity.kind !== 'verified') throw new Error('fixture identity');
  const who = w.options.identity;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot,
    state, expires_at, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES ('regression-publisher', ?, 'case', ?, ?, ?, 'staff', 'publisher', 'publisher', 'active', NULL, 1, 'grant-op', '{}', ?, ?, ?)`,
    CLIENT, CASE, who.principal.issuer, who.principal.subject, who.principal.issuer, who.principal.subject, NOW);
  const identity: SignoffIdentity = { candidateId: signed.candidateId, linkId: signed.linkId, submissionRevisionId: signed.submissionRevisionId,
    submissionManifestSha256: signed.submissionManifestSha256, resultsVersion: signed.resultsVersion, manifestSha256: signed.manifestSha256,
    packageInputRevisionId: signed.packageInputRevisionId, diagnosticsSha256: signed.diagnosticsSha256,
    validatorVersion: signed.validatorVersion, snapshotRevision: signed.snapshotRevision };
  const op: OperationRecord = { operationId: 'publish-regression', requestSha256: 'b'.repeat(64), clientId: CLIENT, caseId: CASE,
    kind: 'publish', signoffId: signed.signoffId, resultsVersion: w.rv, expected: { kind: 'none' }, actor: who.principal,
    signedIdentity: identity, state: 'pending', reason: null, at: NOW,
    auditEvent: { ...signed.auditEvent, eventId: 'publish-regression-audit', action: 'publication.publish',
      object: { kind: 'publication', id: 'publish-regression', caseId: CASE } } };
  await ledger.beginOperation(op);
  const { state: _state, reason: _reason, ...intent } = op;
  const publisher = d1PublicationPublisher({ db: w.db, clientId: CLIENT, checkSession: async () => {} });
  const outcome = await publisher.publish({ intent, authority: { ...w.scope, principal: who.principal, sessionId: who.sessionId, capability: 'publish' },
    async recheck() {
      w.db.exec("UPDATE rs_original_upload SET state = 'stored'");
      w.db.exec("UPDATE rs_original_upload SET state = 'finalized'");
    } });
  expect(outcome).toEqual({ kind: 'guard-refused', reason: 'signoff-stale' });
  expect(await publisher.receipt({ ...w.scope, operationId: op.operationId })).toBeNull();
  expect(w.db.rows<Row>('SELECT * FROM rs_publication')).toEqual([]);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
});

it('rolls provenance, generation and sign-off invalidation back together on an interrupted D1 batch', async () => {
  const w = await setup(), { ledger, signed } = await approve(w), before = generation(w);
  await expect(w.db.batch([
    w.db.prepare("UPDATE rs_original_upload SET state = 'stored' WHERE case_id = ?").bind(CASE),
    w.db.prepare('INSERT INTO rs_batch_guard (token) VALUES (NULL)'),
  ])).rejects.toThrow();
  expect(generation(w)).toBe(before);
  expect(w.db.rows<Row>('SELECT state FROM rs_original_upload')[0].state).toBe('finalized');
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).toBeNull();
  expect((await w.read())?.snapshotRevision).toBe(signed.snapshotRevision);
});

it('retires pre-migration sign-offs without changing intake/package data', async () => {
  const w = await setup({ provenanceMigration: false }), { ledger, signed, snapshot } = await approve(w), before = generation(w);
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0003_provenance_generation.sql', 'utf8'));
  expect(generation(w)).toBeGreaterThan(before);
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
  expect((await w.read())?.validation).toEqual(snapshot.validation);
  expect(await d1PublicationSnapshotRevision(w.db, w.scope)).not.toBe(signed.snapshotRevision);
});

it('still accepts a later genuine submission with idempotent retries and keeps the current package readable', async () => {
  const w = await setup(), { ledger, signed } = await approve(w), originals = createOriginalIntake(w.ctx), submissions = d1SubmissionRepository(w.db);
  const mapped = w.link.coverage.mappedOriginals[0];
  const input = { clientId: CLIENT, caseId: CASE, operationId: 'later-upload', assetId: 'sub-later-upload', path: 'DOCS/Later.pdf', filename: 'Later.pdf',
    mediaType: 'application/pdf' as const, size: w.bytes.byteLength, sha256: mapped.sha256, principal: { issuer: 'synthetic', subject: 'uploader' }, at: NOW };
  expect((await submissions.declare(input)).kind).toBe('declared');
  expect((await originals.declare(input)).kind).toBe('declared');
  expect((await originals.put({ ...input, bytes: w.bytes })).kind).toBe('stored');
  await submissions.markStored(input);
  await submissions.reserveRevision(input);
  expect((await originals.finalize(input)).kind).toBe('finalized');
  const manifest = await submissions.commitRevision(input);
  expect(manifest.sequence).toBe(2);
  expect(await submissions.commitRevision(input)).toEqual(manifest);
  expect((await originals.finalize(input)).kind).toBe('finalized');
  expect((await ledger.signoff({ ...w.scope, signoffId: signed.signoffId }))?.invalidatedAt).not.toBeNull();
  expect((await w.read())?.requiredPreviews).toEqual([{ assetId: 'OD-001', state: 'rendered' }]);
});
