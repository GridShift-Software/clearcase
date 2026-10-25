// Synthetic component evidence. Real native repository and request audit adapter over SQLite-as-D1, not real D1.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { requestAuditSink } from '../../../src/lib/audit/facades.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import type { D1 } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import type { IdentityState } from '../../../src/lib/server/runtime/contracts.ts';
import { createCandidateReader, createNativeResultsImport, d1NativeCandidateRepository, recoverNativeCandidateAudits, type CandidateAuditRecovery, type NativeD1, type NativeImportPorts, type StageRequest } from '../../../src/lib/results-review/native/index.ts';
import { CASE_A, CASE_B, CLIENT, NOW, finalizeSubmission, who } from './doubles.ts';
import { buildFixture, pdf } from './fixtures.ts';
import { world } from './harness.ts';

let seq = 0;
const op = () => `recovery-${++seq}-abcdef1234567890`;
const scope = { clientId: CLIENT, caseId: CASE_A };
const correction = (candidateId: string) => ({ operationId: op(), candidateId, reason: 'Synthetic correction', replacements: [{ key: 'matter', data: { title: 'Corrected', short: 'M', forum: 'High Court', storyline: [], strategy: [] } }] });
async function ready() {
  const w = world();
  const file = { path: 'Letters/Claim.pdf', bytes: pdf('audit recovery') };
  const manifest = await finalizeSubmission(w.db, { operationId: op(), file });
  w.stager.folder = new Map([[file.path, file.bytes]]);
  const fx = buildFixture({ docs: [{ ref: 'OD-001', ...file }] });
  const ports = w.ports as unknown as NativeImportPorts;
  const repo = ports.repository!;
  const service = createNativeResultsImport(ports)!;
  const token = await service.admit({ identity: who(), caseId: CASE_A, access: 'write' });
  const request = { operationId: op(), submissionRevisionId: manifest.revisionId, files: fx.files };
  const reader = createCandidateReader(ports)!;
  // Double only: no trusted audit recovery adapter exists in production yet.
  const recovery: CandidateAuditRecovery = { appendCommitted: intent => w.audit.append(intent.event) };
  return { w, ports, repo, service, token, request, reader, recovery, manifest };
}

it('commits intent and correction provenance atomically, then recovers without an uploader retry', async () => {
  const x = await ready();
  const imported = await x.service.importPackage(x.token, x.request);
  if (imported.kind !== 'linked') throw new Error('setup import failed');
  x.w.audit.failAlways = true;
  await expect(x.service.correct(x.token, correction(imported.candidate.candidateId))).rejects.toMatchObject({ code: 'audit-unavailable' });
  expect(await x.reader.current(scope)).toEqual([]); // pending correction also holds sign-off of the superseded parent
  const pending = await x.repo.pendingAudits({ ...scope, limit: 10 });
  expect(pending).toHaveLength(1);
  expect(pending[0].event.action).toBe('results.correct-candidate');
  expect((await x.repo.candidate({ ...scope, candidateId: pending[0].candidateId }))?.correction?.reason).toBe('Synthetic correction');
  // New repository instance models recovery after Worker/request loss.
  const restarted = d1NativeCandidateRepository(x.w.db as unknown as NativeD1);
  await expect(recoverNativeCandidateAudits({ ...scope, repository: restarted, recovery: x.recovery, limit: 10 })).rejects.toMatchObject({ code: 'audit-unavailable' });
  expect(await x.reader.current(scope)).toEqual([]);
  x.w.audit.failAlways = false;
  expect(await recoverNativeCandidateAudits({ ...scope, repository: restarted, recovery: x.recovery, limit: 10 })).toBe(1);
  expect((await x.reader.current(scope)).map(c => c.candidateId)).toEqual([pending[0].candidateId]);
  expect(x.w.audit.events.filter(e => e.action === 'results.correct-candidate')).toEqual([pending[0].event]);
  expect(await recoverNativeCandidateAudits({ ...scope, repository: restarted, recovery: x.recovery, limit: 10 })).toBe(0);
});

it('rolls back candidate, link and correction if inserting the audit intent fails', async () => {
  const x = await ready();
  x.w.db.failNext = /INSERT INTO native_candidate_audit_intent/;
  await expect(x.service.importPackage(x.token, x.request)).rejects.toMatchObject({ code: 'storage-unavailable' });
  for (const t of ['native_candidate', 'native_import_link', 'native_candidate_audit_intent']) expect(x.w.db.rows(`SELECT * FROM ${t}`)).toEqual([]);
  const imported = await x.service.importPackage(x.token, x.request);
  if (imported.kind !== 'linked') throw new Error('setup import failed');
  const fix = correction(imported.candidate.candidateId);
  x.w.db.failNext = /INSERT INTO native_candidate_audit_intent/;
  await expect(x.service.correct(x.token, fix)).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(x.w.db.rows('SELECT * FROM native_candidate_supersession')).toEqual([]);
  expect(x.w.db.rows('SELECT * FROM native_correction_change')).toEqual([]);
  expect((await x.reader.current(scope)).map(c => c.candidateId)).toEqual([imported.candidate.candidateId]);
  expect((await x.service.correct(x.token, fix)).kind).toBe('linked');
});

it('replays the identical event after append succeeds but settlement fails, including concurrent recovery', async () => {
  const x = await ready();
  x.w.db.failNext = /INSERT INTO native_candidate_audit_settlement/;
  await expect(x.service.importPackage(x.token, x.request)).rejects.toMatchObject({ code: 'storage-unavailable' });
  const pending = await x.repo.pendingAudits({ ...scope, limit: 10 });
  expect(pending).toHaveLength(1);
  expect(x.w.audit.events).toEqual([pending[0].event]);
  expect(await x.reader.current(scope)).toEqual([]);
  const restart = d1NativeCandidateRepository(x.w.db as unknown as NativeD1);
  await Promise.all([x.repo, restart].map(repository => recoverNativeCandidateAudits({ ...scope, repository, recovery: x.recovery, limit: 10 })));
  expect(x.w.audit.events).toEqual([pending[0].event]);
  expect(await x.reader.current(scope)).toHaveLength(1);
  expect(x.w.db.rows('SELECT * FROM native_candidate_audit_settlement')).toHaveLength(1);
});

it('leaves intent pending on a wrong acknowledgment and bounds recovery to the exact case', async () => {
  const x = await ready();
  x.w.audit.failNext = true;
  await expect(x.service.importPackage(x.token, x.request)).rejects.toMatchObject({ code: 'audit-unavailable' });
  const wrong = { appendCommitted: async () => ({ eventId: 'not-the-committed-event' }) };
  await expect(recoverNativeCandidateAudits({ ...scope, repository: x.repo, recovery: wrong, limit: 1 })).rejects.toMatchObject({ code: 'integrity' });
  expect(await x.reader.current(scope)).toEqual([]);
  expect(await recoverNativeCandidateAudits({ ...scope, caseId: CASE_B, repository: x.repo, recovery: x.recovery, limit: 1 })).toBe(0);
  await expect(recoverNativeCandidateAudits({ ...scope, repository: x.repo, recovery: x.recovery, limit: 0 })).rejects.toThrow('limit');
  expect(await x.repo.pendingAudits({ ...scope, limit: 1 })).toHaveLength(1);
  expect(await recoverNativeCandidateAudits({ ...scope, repository: x.repo, recovery: x.recovery, limit: 1 })).toBe(1);
});

it('retains write-once audit intent and settlement, including INSERT OR REPLACE protection', async () => {
  const x = await ready();
  expect((await x.service.importPackage(x.token, x.request)).kind).toBe('linked');
  for (const table of ['native_candidate_audit_intent', 'native_candidate_audit_settlement']) {
    const [row] = x.w.db.rows<Record<string, string>>(`SELECT * FROM ${table}`);
    expect(() => x.w.db.exec(`DELETE FROM ${table}`)).toThrow();
    expect(() => x.w.db.exec(`UPDATE ${table} SET event_id = 'forged'`)).toThrow();
    const cols = Object.keys(row);
    expect(() => x.w.db.exec(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map(k => row[k]))).toThrow();
    expect(x.w.db.rows(`SELECT * FROM ${table}`)).toEqual([row]);
  }
});

it('refuses tampered committed event bytes even on an already settled candidate read', async () => {
  const x = await ready();
  expect((await x.service.importPackage(x.token, x.request)).kind).toBe('linked');
  x.w.db.exec('DROP TRIGGER native_audit_intent_no_update'); // simulate storage tampering below protection
  x.w.db.exec("UPDATE native_candidate_audit_intent SET event_json = '{}'");
  await expect(x.reader.current(scope)).rejects.toMatchObject({ code: 'integrity' });
  await expect(x.repo.pendingAudits({ ...scope, limit: 10 })).resolves.toEqual([]); // settled intents are not redelivered
});

it('hands the stager the exact trusted finalized revision, not a package-selected original identity', async () => {
  const x = await ready();
  let handed: StageRequest | undefined;
  const stager = { stage: async (a: StageRequest) => { handed = a; return x.ports.stager!.stage(a); } };
  const service = createNativeResultsImport({ ...x.ports, stager })!;
  const token = await service.admit({ identity: who(), caseId: CASE_A, access: 'write' });
  expect((await service.importPackage(token, x.request)).kind).toBe('linked');
  expect(handed?.submission.manifest).toEqual(x.manifest);
  expect(handed?.submission.storedManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(handed?.submission.manifest.revisionId).toBe(x.request.submissionRevisionId);
});

it('uses the real requestAuditSink for original-principal retry and never impersonates that actor during another review', async () => {
  const x = await ready();
  x.w.db.sqlite.exec(readFileSync(new URL('../../../src/lib/audit/migrations/0001_native_audit.sql', import.meta.url), 'utf8'));
  const config = auditConfig({ clientId: CLIENT, trustedIssuers: ['https://issuer.test'], limits: { maxEventBytes: 4096, maxRows: 100, maxReadRows: 100, maxDenialRows: 100, maxDenialsPerActor: 100, maxPageRows: 100, maxPagesPerRequest: 10 } });
  const db = x.w.db as unknown as D1;
  const now = () => new Date(NOW);
  await provisionAuditBinding({ db, config, now });
  const requester = (subject: string, session?: string): IdentityState => {
    const identity = who({ subject, session });
    if (identity.kind !== 'verified') throw new Error('verified fixture required');
    return { kind: 'verified', principal: identity.principal, sessionId: identity.sessionId };
  };
  const originalAudit = requestAuditSink({ db, config, requester: requester('operator-1'), now });
  const service = createNativeResultsImport({ ...x.ports, audit: originalAudit })!;
  const token = await service.admit({ identity: who(), caseId: CASE_A, access: 'write' });
  x.w.db.failNext = /INSERT INTO native_audit_events/;
  await expect(service.importPackage(token, x.request)).rejects.toMatchObject({ code: 'audit-unavailable' });
  const [intent] = await x.repo.pendingAudits({ ...scope, limit: 1 });
  const otherAudit = requestAuditSink({ db, config, requester: requester('reviewer-2'), now });
  await expect(otherAudit.append(intent.event)).rejects.toMatchObject({ code: 'invalid-event' });
  const other = createNativeResultsImport({ ...x.ports, audit: otherAudit })!;
  const otherToken = await other.admit({ identity: who({ subject: 'reviewer-2' }), caseId: CASE_A, access: 'read' });
  expect((await other.listCandidates(otherToken))[0].current).toBe(false);
  expect(await x.reader.current(scope)).toEqual([]);
  const later = createNativeResultsImport({ ...x.ports, audit: requestAuditSink({ db, config, requester: requester('operator-1', 'later-session'), now }) })!;
  const laterToken = await later.admit({ identity: who({ session: 'later-session' }), caseId: CASE_A, access: 'write' });
  const result = await later.importPackage(laterToken, x.request);
  expect(result).toMatchObject({ kind: 'linked', repeated: true, candidate: { current: true } });
  expect(x.w.db.rows('SELECT * FROM native_audit_events WHERE action = ?', 'results.import-candidate')).toHaveLength(1);
  expect((await x.repo.auditIntent({ ...scope, candidateId: intent.candidateId })).event).toEqual(intent.event);
  const fixed = await later.correct(laterToken, correction(intent.candidateId));
  expect(fixed).toMatchObject({ kind: 'linked', candidate: { current: true } });
  expect(x.w.db.rows('SELECT * FROM native_audit_events WHERE action = ?', 'results.correct-candidate')).toHaveLength(1);
});
