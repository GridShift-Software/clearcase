import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { canonical, envelopeOf, sha256Hex } from '../../../src/lib/audit/event.ts';
import { requestAuditSink, publicAuditReader } from '../../../src/lib/audit/facades.ts';
import { provisioningCore } from '../../../src/lib/audit/d1-log.ts';
import { committedAuditRecovery } from '../../../src/lib/audit/recovery.ts';
import { CLIENT, CASE, OTHER_CASE, NOW, PRINCIPAL, SESSION, World, config, now, pubEvent, requester, rv } from './harness.ts';

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
async function world() { const w = new World(); worlds.push(w); return w.ready(); }
async function prepared(w: World) {
  await w.candidate(); await w.settleCandidates();
  const so = await w.signoff();
  await w.recovery().publication.append(so.auditEvent);
  await w.ledger.settleSignoff({ clientId: CLIENT, caseId: CASE, signoffId: so.signoffId });
  return so;
}
const alter = (e: AuditEvent, change: (e: AuditEvent) => void) => { const out = structuredClone(e); change(out); return out; };
const mutations: [string, (e: AuditEvent) => void][] = [
  ['event id', (e) => { e.eventId += '-forged'; }],
  ['principal', (e) => { if (e.actor.kind === 'verified') e.actor.principal = { ...e.actor.principal, subject: 'forged-actor' }; }],
  ['issuer', (e) => { if (e.actor.kind === 'verified') e.actor.principal = { ...e.actor.principal, issuer: 'https://foreign.test' }; }],
  ['session', (e) => { if (e.actor.kind === 'verified') e.actor.sessionId = id('session', 'new-session'); }],
  ['time', (e) => { e.at = '2026-10-26T08:00:00.000Z'; }],
  ['content/version', (e) => { e.version = rv('2'); }],
  ['outcome', (e) => { e.outcome = 'failed'; }],
  ['case', (e) => { e.object.caseId = OTHER_CASE; }],
  ['object', (e) => { e.object.id += '-other'; }],
];

describe('committed candidate delivery', () => {
  it('exposes only frozen, source-constrained ports and requires a raw primary-capable binding', async () => {
    const w = await world(), recovery = w.recovery();
    expect(Object.keys(recovery).sort()).toEqual(['candidate', 'publication']);
    expect(Object.keys(recovery.candidate)).toEqual(['appendCommitted']);
    expect(Object.keys(recovery.publication)).toEqual(['append']);
    expect(Object.isFrozen(recovery) && Object.isFrozen(recovery.candidate) && Object.isFrozen(recovery.publication)).toBe(true);
    expect(() => committedAuditRecovery({ db: { ...w.db, withSession: undefined } as never, config: w.cfg, now })).toThrow('raw D1');
    const intent = await w.candidate();
    await recovery.candidate.appendCommitted(intent);
    expect(w.db.sessions.length).toBeGreaterThan(0);
    expect(new Set(w.db.sessions)).toEqual(new Set(['first-primary']));
  });

  it('rejects arbitrary, absent, foreign client/case/candidate hints; input does not authorize itself', async () => {
    const w = await world(), intent = await w.candidate(), port = w.recovery().candidate;
    const hints = [
      { ...intent, clientId: id('client', 'client-b') },
      { ...intent, caseId: OTHER_CASE },
      { ...intent, candidateId: 'absent-candidate' },
      { ...intent, candidateId: 'candidate-2' },
      { ...intent, event: await pubEvent('publication.publish', 'arbitrary-operation', rv()) },
    ];
    for (const hint of hints) await expect(port.appendCommitted(hint)).rejects.toBeTruthy();
    expect(w.auditRows()).toEqual([]);
    expect((await w.repository.candidate(intent))?.current).toBe(false);
  });

  it.each(mutations)('rejects candidate %s substitution against the retained canonical source', async (_name, change) => {
    const w = await world(), intent = await w.candidate();
    await expect(w.recovery().candidate.appendCommitted({ ...intent, event: alter(intent.event, change) })).rejects.toBeTruthy();
    expect(w.auditRows()).toEqual([]);
  });

  it('retains original bytes across revocation, another requester, restart, supersession and settlement replay', async () => {
    const w = await world(), intent = await w.candidate();
    const original = (await envelopeOf(intent.event, w.cfg)).canonical;
    w.revoke();
    // A different current request still cannot impersonate the historical operator.
    const foreign = requestAuditSink({ db: w.db, config: w.cfg, now,
      requester: { kind: 'verified', principal: { ...PRINCIPAL, subject: 'different-reviewer' }, sessionId: id('session', 'reviewer-session') } });
    await expect(foreign.append(intent.event)).rejects.toMatchObject({ code: 'invalid-event' });
    await expect(provisioningCore({ db: w.db, config: w.cfg, now }).append(intent.event as never)).rejects.toMatchObject({ code: 'invalid-event' });
    await expect(w.recovery().candidate.appendCommitted(intent)).resolves.toEqual({ eventId: intent.event.eventId });
    expect((await w.repository.candidate(intent))?.current).toBe(false); // delivery alone never settles
    await w.repository.settleAudit(intent);
    expect((await w.repository.candidate(intent))?.current).toBe(true);
    await w.candidate('2', intent.candidateId);
    w.restart();
    await expect(w.recovery().candidate.appendCommitted(intent)).resolves.toEqual({ eventId: intent.event.eventId });
    await w.repository.settleAudit(intent);
    expect(w.auditRows()).toHaveLength(1);
    expect(w.auditRows()[0].canonical).toBe(original);
    expect((await w.repository.candidate(intent))?.current).toBe(false); // supersession is not undone
    expect(await w.settleCandidates()).toBe(1); // correction has its own original event
    expect(w.auditRows()).toHaveLength(2);
    expect(w.auditRows()[1].canonical).toContain('results.correct-candidate');
  });

  it('snapshots mutable caller input before awaiting source reads', async () => {
    const w = await world(), intent = { ...structuredClone(await w.candidate()) }, original = structuredClone(intent.event);
    w.db.sourceHook = () => { intent.event.at = '2026-10-26T08:00:00.000Z'; intent.candidateId = 'changed'; };
    await expect(w.recovery().candidate.appendCommitted(intent)).resolves.toEqual({ eventId: original.eventId });
    expect(w.auditRows()[0].canonical).toBe((await envelopeOf(original, w.cfg)).canonical);
  });

  it('detects an existing audit id with different bytes instead of acknowledging it', async () => {
    const w = await world(), intent = await w.candidate();
    await requestAuditSink({ db: w.db, config: w.cfg, requester, now }).append({ ...intent.event, action: 'case.read' });
    await expect(w.recovery().candidate.appendCommitted(intent)).rejects.toMatchObject({ code: 'audit-conflict' });
    expect(await w.repository.pendingAudits({ clientId: CLIENT, caseId: CASE, limit: 100 })).toHaveLength(1);
    expect(w.auditRows()).toHaveLength(1);
  });

  it.each(['drop', 'lost-readback'] as const)('keeps a candidate pending after %s, then resumes exact delivery', async (fault) => {
    const w = await world(), intent = await w.candidate();
    w.db.auditFault = fault;
    await expect(w.settleCandidates()).rejects.toMatchObject({ code: 'audit-unavailable' });
    expect((await w.repository.candidate(intent))?.current).toBe(false);
    w.db.auditFault = 'none'; w.db.failAuditReads = false; w.restart();
    expect(await w.settleCandidates()).toBe(1);
    expect(w.auditRows()).toHaveLength(1);
    expect(w.auditRows()[0].canonical).toBe((await envelopeOf(intent.event, w.cfg)).canonical);
  });

  it('accepts a lost write acknowledgement only after exact readback', async () => {
    const w = await world(), intent = await w.candidate();
    w.db.auditFault = 'lost-ack';
    expect(await w.settleCandidates()).toBe(1);
    expect(w.auditRows()).toHaveLength(1);
    expect(w.auditRows()[0].canonical).toBe((await envelopeOf(intent.event, w.cfg)).canonical);
  });

  it('respects protected-event capacity, but still acknowledges an exact replay at the bound', async () => {
    const w = await world(), first = await w.candidate(), second = await w.candidate('2');
    const port = w.recovery(1).candidate;
    await port.appendCommitted(first);
    await expect(port.appendCommitted(first)).resolves.toEqual({ eventId: first.event.eventId });
    await expect(port.appendCommitted(second)).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
    expect(w.auditRows()).toHaveLength(1);
    expect((await w.repository.candidate(second))?.current).toBe(false);
    expect(await w.settleCandidates()).toBe(2); // parent can retry with restored/configured capacity
  });
});

describe('committed publication delivery', () => {
  it.each(mutations)('rejects sign-off %s substitution', async (_name, change) => {
    const w = await world(); await w.candidate();
    const so = await w.signoff();
    await expect(w.recovery().publication.append(alter(so.auditEvent, change))).rejects.toBeTruthy();
    expect(w.auditRows()).toEqual([]);
    expect((await w.ledger.signoff(so))?.state).toBe('recorded');
  });

  it('refuses arbitrary events, anonymous/system actors, missing/foreign source rows and wrong action', async () => {
    const w = await world(); await w.candidate(); const so = await w.signoff(), sink = w.recovery().publication;
    const events = [await pubEvent('publication.signoff', 'so-absent', rv()),
      { ...so.auditEvent, action: 'publication.publish' }, { ...so.auditEvent, action: 'audit.read' },
      { ...so.auditEvent, actor: { kind: 'anonymous', principal: null, sessionId: null } },
      { ...so.auditEvent, actor: { kind: 'system', component: 'provisioning', operator: 'operator' } },
      { ...so.auditEvent, object: { ...so.auditEvent.object, caseId: OTHER_CASE } },
      { ...so.auditEvent, extra: 'cannot-store' },
    ];
    for (const e of events) await expect(sink.append(e as AuditEvent)).rejects.toBeTruthy();
    const foreign = committedAuditRecovery({ db: w.db, config: config(1000, id('client', 'client-b')), now });
    await expect(foreign.publication.append(so.auditEvent)).rejects.toMatchObject({ code: 'audit-unavailable' });
    expect(w.auditRows()).toEqual([]);
  });

  it('checks retained sign-off bytes against immutable signer/time/id/version columns, not mere persistence', async () => {
    const w = await world(); await w.candidate();
    const forged = alter(await pubEvent('publication.signoff', 'so-signoff-operation-0001', rv()), (e) => {
      if (e.actor.kind === 'verified') e.actor.principal = { ...e.actor.principal, subject: 'not-the-signer' };
    });
    const so = await w.signoff('candidate-1', 'signoff-operation-0001', forged);
    await expect(w.recovery().publication.append(so.auditEvent)).rejects.toMatchObject({ code: 'invalid-event' });
    expect(w.auditRows()).toEqual([]);
  });

  it('retains SQL source immutability and refuses a forged apply receipt', async () => {
    const w = await world(), so = await prepared(w), op = await w.operation(so);
    const changed = { ...op, auditEvent: { ...op.auditEvent, at: '2026-10-26T08:00:00.000Z' } };
    expect(() => w.db.insert('pub_apply_receipt', { operation_id: op.operationId, client_id: CLIENT, case_id: CASE,
      intent_json: canonical(changed), authority_issuer: PRINCIPAL.issuer, authority_subject: PRINCIPAL.subject,
      authority_kind: PRINCIPAL.kind, authority_session_id: SESSION })).toThrow('pub:intent-mismatch');
    await expect(w.recovery().publication.append(changed.auditEvent)).rejects.toMatchObject({ code: 'invalid-event' });
    expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
    expect(await w.apply(op)).toMatchObject({ kind: 'applied' });
    expect(() => w.db.sql.prepare('UPDATE pub_apply_receipt SET intent_json = ? WHERE operation_id = ?').run(canonical(changed), op.operationId)).toThrow();
    expect(() => w.db.sql.prepare('UPDATE pub_signoff SET audit_event = ? WHERE signoff_id = ?').run(canonical(changed.auditEvent), so.signoffId)).toThrow();
    expect(() => w.db.sql.prepare('UPDATE pub_operation SET audit_event = ? WHERE operation_id = ?').run(canonical(changed.auditEvent), op.operationId)).toThrow();
    expect(() => w.db.sql.prepare("UPDATE native_candidate_audit_intent SET event_json = '{}' WHERE candidate_id = 'candidate-1'").run()).toThrow();
    await expect(w.recovery().publication.append(op.auditEvent)).resolves.toEqual({ eventId: op.auditEvent.eventId });
  });

  it('delivers an invalidated historical sign-off after revocation without making it effective or publishing', async () => {
    const w = await world(); await w.candidate(); const so = await w.signoff();
    await w.ledger.invalidateSignoff({ ...so, at: NOW, reason: 'candidate-changed' });
    w.revoke(); w.restart();
    await w.recovery().publication.append(so.auditEvent);
    expect((await w.ledger.signoff(so))?.state).toBe('recorded');
    expect((await w.ledger.signoff(so))?.invalidatedReason).toBe('candidate-changed');
    expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
    expect(w.auditRows()[0].canonical).toBe((await envelopeOf(so.auditEvent, w.cfg)).canonical);
  });

  it('never infers application from pointer equality or applied/failed/refused ledger labels', async () => {
    const w = await world(), so = await prepared(w), applied = await w.operation(so);
    expect(await w.apply(applied)).toMatchObject({ kind: 'applied' });
    const baseline = w.auditRows().length;
    for (const state of ['pending', 'applied', 'failed', 'refused'] as const) {
      const op = await w.operation(so, `uncommitted-${state}`);
      if (state !== 'pending') await w.ledger.finishOperation({ ...op, state, reason: 'synthetic' });
      await expect(w.recovery().publication.append(op.auditEvent)).rejects.toMatchObject({ code: 'invalid-event' });
    }
    expect(w.auditRows()).toHaveLength(baseline);
    expect(w.db.rows('SELECT * FROM pub_apply_receipt')).toHaveLength(1);
  });

  it.each(mutations)('rejects applied operation %s substitution', async (_name, change) => {
    const w = await world(), so = await prepared(w), op = await w.operation(so);
    await w.apply(op); const before = w.auditRows().length;
    await expect(w.recovery().publication.append(alter(op.auditEvent, change))).rejects.toBeTruthy();
    expect(w.auditRows()).toHaveLength(before);
  });

  it('recovers pending and failed receipts after withdrawal, supersession, revocation and restart, without reapplying', async () => {
    const w = await world(), so = await prepared(w), op = await w.operation(so);
    expect(await w.apply(op, id('session', 'fresh-retry-session'))).toMatchObject({ kind: 'applied' });
    await w.ledger.finishOperation({ ...op, state: 'failed', reason: 'lost-ack' });
    const withdraw = await w.operation(so, 'withdraw-operation-0001', 'withdraw');
    expect(await w.apply(withdraw)).toMatchObject({ kind: 'applied' });
    await w.candidate('2', so.candidateId); w.revoke(); w.restart();
    const pointer = w.db.rows('SELECT * FROM rs_publication'), receipts = w.db.rows('SELECT * FROM pub_apply_receipt');
    const newOperation = await w.operation(so, 'revoked-new-operation');
    expect(await w.apply(newOperation)).toMatchObject({ kind: 'guard-refused', reason: 'invalid-session' });
    expect(await w.apply(newOperation, id('session', 'another-new-session'))).toMatchObject({ kind: 'guard-refused', reason: 'forbidden' });
    await expect(w.recovery().publication.append(newOperation.auditEvent)).rejects.toMatchObject({ code: 'invalid-event' });
    const sink = w.recovery().publication;
    for (const intent of [op, withdraw]) {
      await expect(sink.append(intent.auditEvent)).resolves.toEqual({ eventId: intent.auditEvent.eventId });
      await expect(sink.append(intent.auditEvent)).resolves.toEqual({ eventId: intent.auditEvent.eventId });
      const row = w.auditRows().find((r) => r.event_id === intent.auditEvent.eventId)!;
      expect(row.canonical).toBe((await envelopeOf(intent.auditEvent, w.cfg)).canonical);
      expect(row.sha256).toBe(await sha256Hex(row.canonical));
      // Parent, not delivery, reconciles operation outcome and settlement.
      expect((await w.ledger.operation(intent))?.state).toBe(intent === op ? 'failed' : 'pending');
      await w.ledger.finishOperation({ ...intent, state: 'applied', reason: null });
      await w.ledger.settleOperation(intent);
    }
    expect(w.db.rows('SELECT * FROM rs_publication')).toEqual(pointer);
    expect(w.db.rows('SELECT * FROM pub_apply_receipt')).toEqual(receipts);
    expect(pointer[0].state).toBe('withdrawn');
    expect(w.auditRows()).toHaveLength(4);
    expect(w.auditRows().every((r) => r.actor_kind === 'verified' && r.at === NOW)).toBe(true);
  });

  it('does not settle publication on write/readback failure or budget exhaustion; exact retry survives restart', async () => {
    const w = await world(), so = await prepared(w), op = await w.operation(so); await w.apply(op);
    await expect(w.recovery(2).publication.append(op.auditEvent)).rejects.toMatchObject({ code: 'audit-unavailable' });
    w.db.auditFault = 'lost-readback';
    await expect(w.recovery().publication.append(op.auditEvent)).rejects.toMatchObject({ code: 'audit-unavailable' });
    expect((await w.ledger.operation(op))?.state).toBe('pending');
    w.restart();
    await expect(w.recovery().publication.append(op.auditEvent)).resolves.toEqual({ eventId: op.auditEvent.eventId });
    expect(w.auditRows()).toHaveLength(3);
    expect((await w.ledger.operation(op))?.state).toBe('pending');
  });

  it('keeps public requester matching, system isolation, read gates and session-free projections intact', async () => {
    const w = await world(); await w.candidate(); const so = await w.signoff(); await w.recovery().publication.append(so.auditEvent);
    const system = { ...so.auditEvent, eventId: 'forged-system', actor: { kind: 'system', component: 'provisioning', operator: 'operator' } };
    const requestSink = requestAuditSink({ db: w.db, config: w.cfg, requester, now });
    await expect(requestSink.append(system as never)).rejects.toMatchObject({ code: 'invalid-event' });
    const reader = publicAuditReader({ db: w.db, config: w.cfg, requester, now,
      gate: { caseAudit: async () => {}, administrationAudit: async () => { throw new Error('denied'); } } });
    const page = await reader.query({ scope: { kind: 'case', caseId: CASE }, cursor: null, limit: 20 });
    expect(JSON.stringify(page)).not.toContain(SESSION);
    expect(page.events[0].actor).toMatchObject({ kind: 'verified', subject: PRINCIPAL.subject });
    expect(page.events[0].action).toBe('publication.signoff');
    const denied = publicAuditReader({ db: w.db, config: w.cfg, requester, now,
      gate: { caseAudit: async () => { throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); }, administrationAudit: async () => {} } });
    await expect(denied.query({ scope: { kind: 'case', caseId: CASE }, cursor: null, limit: 20 })).rejects.toBeTruthy();
    expect(canonical(so.auditEvent)).not.toContain('fresh-retry-session');
  });
});
