// GRS-114 approved supplemental correction: the trusted provisioning port records a system actor durably, and nothing
// else may. node:sqlite stand-in only; unit results, not D1, workerd or provider evidence.
import { describe, expect, it } from 'vitest';
import type { SystemAuditEvent } from '../../../src/lib/server/runtime/contracts.ts';
import { publicAuditReader } from '../../../src/lib/audit/index.ts';
import { provisioningAuditPort } from '../../../src/lib/audit/provisioning.ts';
import { createD1AuditLog } from '../../../src/lib/audit/trusted.ts';
import { admin, anonymous, config, event, gate, NOW, viewer, world } from './world.ts';

let n = 0;
const system = (over: Partial<SystemAuditEvent> = {}): SystemAuditEvent => ({
  eventId: `grant-op:boot-${++n}`, actor: { kind: 'system', component: 'provisioning', operator: 'provisioning-run-1' }, action: 'grant.bootstrap',
  object: { kind: 'case-grant', id: 'grant-1', caseId: null }, version: null, outcome: 'succeeded', at: '2026-10-24T10:00:00.000Z', ...over,
});
const port = (w: ReturnType<typeof world>) => provisioningAuditPort({ db: w.d1, config: w.config, now: NOW });

describe('trusted provisioning port', () => {
  it('records a system event with its exact canonical bytes, finds it, and tolerates a lost acknowledgement', async () => {
    const w = world(); await w.ready; w.fault.failInsertAfterCommit = true;
    const e = system();
    await expect(port(w).append(e)).resolves.toEqual({ eventId: e.eventId });
    w.fault.failInsertAfterCommit = false;
    await expect(port(w).append(structuredClone(e))).resolves.toEqual({ eventId: e.eventId });
    expect(w.rows()).toHaveLength(1);
    expect(w.db.prepare('SELECT actor_kind, actor_key FROM native_audit_events').get()).toEqual({ actor_kind: 'system', actor_key: null });
    await expect(port(w).find(e.eventId)).resolves.toEqual(e);
    await expect(port(w).find('grant-op:absent')).resolves.toBeNull();
  });
  it('refuses the same id with a different system event as audit-conflict and keeps the first', async () => {
    const w = world(); await w.ready;
    const e = system();
    await port(w).append(e);
    await expect(port(w).append({ ...e, outcome: 'failed' })).rejects.toMatchObject({ code: 'audit-conflict' });
    await expect(port(w).append({ ...e, actor: { ...e.actor, operator: 'another-run' } })).rejects.toMatchObject({ code: 'audit-conflict' });
    expect(w.rows().map((r) => r.outcome)).toEqual(['succeeded']);
  });
  it('accepts nothing but a system actor: no verified or anonymous identity, no extra key, no bad operator, no audit.read', async () => {
    const w = world(); await w.ready;
    const p = port(w);
    const bad = [
      event({ action: 'grant.bootstrap', object: { kind: 'case-grant', id: 'g', caseId: null } }, viewer),
      event({ action: 'grant.bootstrap', object: { kind: 'case-grant', id: 'g', caseId: null } }, anonymous),
      system({ actor: { kind: 'system', component: 'provisioning', operator: 'run', principal: viewer.principal } as never }),
      system({ actor: { kind: 'system', component: 'provisioning', operator: 'run', sessionId: 'sess_x' } as never }),
      system({ actor: { kind: 'system', component: 'provisioning' } as never }),
      system({ actor: { kind: 'system', component: 'other', operator: 'run' } as never }),
      system({ actor: { kind: 'system', component: 'provisioning', operator: 'bad operator!' } }),
      system({ actor: { kind: 'system', component: 'provisioning', operator: 'x'.repeat(129) } }),
      system({ action: 'audit.read' }),
      { ...system(), body: 'case text' },
    ];
    for (const e of bad) await expect(p.append(e as never)).rejects.toMatchObject({ code: 'invalid-event' });
    expect(w.rows()).toEqual([]);
  });
  it('refuses to write into a database bound to another client', async () => {
    const w = world({ clientId: 'client-b' }); await w.ready;
    const other = provisioningAuditPort({ db: w.d1, config: config('client-a'), now: NOW });
    await expect(other.append(system())).rejects.toMatchObject({ code: 'audit-unavailable' });
    expect(w.rows()).toEqual([]);
  });
  it('exposes exactly append and find', () => {
    const w = world();
    expect(Object.keys(port(w)).sort()).toEqual(['append', 'find']);
    expect(Object.isFrozen(port(w))).toBe(true);
  });
});

describe('what request code and readers see of a stored system event', () => {
  it('the public administration view shows a system actor without session, principal or an authenticated-person shape', async () => {
    const w = world(); await w.ready;
    const e = system();
    await port(w).append(e);
    const reader = publicAuditReader({ db: w.d1, config: w.config, requester: admin, gate: gate({ administrators: ['user_admin'] }), now: NOW });
    const page = await reader.query({ scope: { kind: 'administration' }, cursor: null, limit: 10 });
    // the view also lists the reader's own audit.read event (a verified actor, self); only the system event is under test
    const shown = page.events.filter((x) => x.eventId === e.eventId);
    expect(shown).toEqual([{ eventId: e.eventId, actor: { kind: 'system', component: 'provisioning', operator: 'provisioning-run-1' }, action: 'grant.bootstrap', object: { kind: 'case-grant', id: 'grant-1', caseId: null }, version: null, outcome: 'succeeded', at: e.at }]);
    expect(JSON.stringify(shown)).not.toMatch(/session|principal|issuer|subject|verified|"self"|canonical|envelope|sha256/);
  });
  it('a request-side log cannot append a system event under any requester, but a grant lookup can read one back', async () => {
    const w = world(); await w.ready;
    const e = system();
    await port(w).append(e);
    for (const who of [viewer, admin, anonymous]) {
      const log = createD1AuditLog({ db: w.d1, config: w.config, requester: who, gate: gate(), now: NOW });
      await expect(log.append(system({ eventId: `grant-op:forged-${who.kind}` }) as never)).rejects.toMatchObject({ code: 'invalid-event' });
      await expect(log.find(e.eventId)).resolves.toEqual(e);
    }
    expect(w.rows()).toHaveLength(1);
  });
});
