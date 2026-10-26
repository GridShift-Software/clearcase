// GRS-116 fix round 1: adverse regressions found by the request-audit source review (M1 history/binding/counter swap,
// M2 reads consuming protected append capacity, M3 session ids in query output, M4 privileged exports, L4 gate faults).
// First run against 97ff0e9f, where each assertion below failed. node:sqlite stand-in: unit results, not D1 evidence.
import { describe, expect, it } from 'vitest';
import * as publicSurface from '../../../src/lib/audit/index.ts';
import type { IdentityState } from '../../../src/lib/server/runtime/contracts.ts';
import { admin, event, gate, viewer, world, ISSUER_A } from './world.ts';

const ZERO = '0'.repeat(64);
const forged = (extra: { seq?: number; id: string }) =>
  `INSERT OR REPLACE INTO native_audit_events (${extra.seq ? 'seq, ' : ''}event_id, client_id, envelope, action, object_kind, object_id, outcome, actor_kind, at, canonical, sha256) VALUES (${extra.seq ? `${extra.seq}, ` : ''}'${extra.id}', 'client-a', 1, 'case.read', 'case', 'case-a1', 'succeeded', 'verified', '2026-10-24T10:00:00.000Z', 'FORGED', '${ZERO}')`;
const attempt = (f: () => unknown) => { try { f(); } catch { /* refusal is the expected outcome; the state is asserted */ } };
const ask = { scope: { kind: 'case' as const, caseId: 'case-a1' as never }, cursor: null, limit: 10 };

describe('M1 stored history, client binding and counters cannot be swapped by SQL', () => {
  for (const recursive of ['OFF', 'ON']) {
    it(`INSERT OR REPLACE cannot replace a stored event by id or by sequence (recursive_triggers ${recursive})`, async () => {
      const w = world(); await w.ready;
      const e = event(); await w.log().append(e);
      w.db.exec(`PRAGMA recursive_triggers = ${recursive}`);
      const before = w.rows();
      attempt(() => w.db.exec(forged({ id: e.eventId })));
      attempt(() => w.db.exec(forged({ id: 'evt-other', seq: 1 })));
      expect(w.rows()).toEqual(before);
      await expect(w.log().find(e.eventId)).resolves.toEqual(e);
    });
    it(`INSERT OR REPLACE cannot rebind the client or zero the counter (recursive_triggers ${recursive})`, async () => {
      const w = world({ over: { maxRows: 2 } }); await w.ready;
      await w.log().append(event()); await w.log().append(event());
      w.db.exec(`PRAGMA recursive_triggers = ${recursive}`);
      attempt(() => w.db.exec("INSERT OR REPLACE INTO native_audit_binding (singleton, client_id, event_count, bound_at) VALUES (1, 'client-b', 0, 't')"));
      expect(w.db.prepare('SELECT client_id, event_count FROM native_audit_binding').all()).toEqual([{ client_id: 'client-a', event_count: 2 }]);
      await expect(w.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
    });
  }
  it('an arbitrary UPDATE cannot reset the counter, rebind the client or move the binding time', async () => {
    const w = world({ over: { maxRows: 2 } }); await w.ready;
    await w.log().append(event()); await w.log().append(event());
    for (const sql of ['UPDATE native_audit_binding SET event_count = 0', "UPDATE native_audit_binding SET client_id = 'client-b'", "UPDATE native_audit_binding SET bound_at = 'x'", 'UPDATE native_audit_binding SET event_count = event_count - 1']) attempt(() => w.db.exec(sql));
    expect(w.db.prepare('SELECT client_id, event_count FROM native_audit_binding').all()).toEqual([{ client_id: 'client-a', event_count: 2 }]);
    await expect(w.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
  });
});

describe('M2 audited reads cannot use up the protected business append capacity', () => {
  it('repeated denied reads by an ungranted principal leave every protected append possible, and the denials stay uniform', async () => {
    const w = world({ over: { maxRows: 30, maxPagesPerRequest: 20 } }); await w.ready;
    const g = gate({});
    const outcomes = new Set<string>();
    for (let request = 0; request < 3; request++) {
      const log = w.log(viewer, g);
      for (let i = 0; i < 20; i++) outcomes.add(await log.query(ask).then(() => 'served', (e: { code: string; message: string }) => `${e.code}:${e.message}`));
    }
    expect([...outcomes]).toEqual(['forbidden:forbidden']);
    for (let i = 0; i < 30; i++) await expect(w.log().append(event())).resolves.toBeTruthy();
    await expect(w.log().append(event())).rejects.toMatchObject({ code: 'audit-unavailable', retryable: false });
  });
  it('served reads that cannot be audited fail closed with no rows, and protected appends still work afterwards', async () => {
    const w = world({ over: { maxRows: 30, maxReadRows: 10 } }); await w.ready;
    const g = gate({ cases: { user_a1: ['case-a1'] } });
    await w.log().append(event());
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      await w.log(viewer, g).query(ask).catch((e: { code: string }) => { expect(e.code).toBe('audit-unavailable'); refused++; });
    }
    expect(refused).toBeGreaterThan(0);
    await expect(w.log().append(event())).resolves.toBeTruthy();
  });
});

describe('M3 queries never return a session id', () => {
  it('no page (case, administration, own audit events) or error carries any session id, in any field', async () => {
    const w = world(); await w.ready;
    const victim: IdentityState = { kind: 'verified', principal: { issuer: ISSUER_A, subject: 'user_victim', kind: 'client' }, sessionId: 'sess_victim_secret' as never };
    await w.log(victim).append(event({ eventId: 'victim-case' }, victim));
    await w.log(victim).append(event({ eventId: 'victim-admin', action: 'admin.invite', object: { kind: 'invitation', id: 'inv-9', caseId: null } }, victim));
    const g = gate({ cases: { user_a1: ['case-a1'] }, administrators: ['user_admin'] });
    const seen: unknown[] = [];
    seen.push(await w.log(viewer, g).query(ask), await w.log(viewer, g).query(ask));
    seen.push(await w.log(admin, g).query({ scope: { kind: 'administration' }, cursor: null, limit: 20 }));
    // The first refusal settles a macrotask later than the second, so the second rejects while the first is still awaited.
    const slowAdministration: typeof g = { ...g, administrationAudit: async (who) => { await new Promise((resolve) => setTimeout(resolve, 0)); return g.administrationAudit(who); } };
    for (const denied of [w.log(viewer, slowAdministration).query({ scope: { kind: 'administration' }, cursor: null, limit: 5 }), w.log(admin, slowAdministration).query({ ...ask })]) seen.push(await denied.catch((e: unknown) => ({ code: (e as { code: string }).code, message: (e as Error).message, text: String(e) })));
    const text = JSON.stringify(seen);
    expect(text).toContain('victim-case');
    expect(text).not.toMatch(/sess_|sessionId/);
  });
});

describe('M4 the public barrel does not carry the privileged entry points', () => {
  it('provisioning and the full internal log are not exported from the public index', () => {
    expect(Object.keys(publicSurface)).not.toContain('provisionAuditBinding');
    expect(Object.keys(publicSurface)).not.toContain('createD1AuditLog');
  });
});

describe('L4 a genuine gate fault is a failure, not a denial', () => {
  it('records outcome failed, fails closed as identity-unavailable and serves no rows', async () => {
    const w = world(); await w.ready;
    await w.log().append(event());
    const broken = { async caseAudit() { throw new Error('D1_ERROR: grants unavailable'); }, async administrationAudit() { throw new Error('boom'); } };
    await expect(w.log(viewer, broken).query(ask)).rejects.toMatchObject({ code: 'identity-unavailable' });
    expect(w.rows().filter((r) => r.action === 'audit.read').map((r) => [r.outcome, r.case_id])).toEqual([['failed', null]]);
  });
});
