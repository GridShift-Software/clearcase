// GRS-114 approved supplemental correction (25 Oct 2026): the bootstrap's audit actor is an honest SYSTEM actor, never a
// verified staff principal with a fabricated session. Written RED first against f8d2b7b3: node:sqlite stand-ins only.
import { describe, expect, it } from 'vitest';
import { client, world } from './world.ts';

const OPERATOR = 'provisioning-run-1';
const bootstrapEvent = (w: ReturnType<typeof world>) => {
  const found = w.events.filter((e) => e.action === 'grant.bootstrap');
  expect(found).toHaveLength(1);
  return found[0] as { eventId: string; actor: Record<string, unknown> };
};

describe('bootstrap audit attribution', () => {
  it('records the bootstrap as a system actor that carries no principal, session or verified claim', async () => {
    const w = world();
    expect(await w.bootstrap.grantManager({ operator: OPERATOR, operationId: 'boot-1', target: client('user_admin'), expiresAt: null })).toMatchObject({ kind: 'applied' });
    const { actor } = bootstrapEvent(w);
    expect(actor).toEqual({ kind: 'system', component: 'provisioning', operator: OPERATOR });
    expect(Object.keys(actor).sort()).toEqual(['component', 'kind', 'operator']);
    expect(actor).not.toHaveProperty('principal');
    expect(actor).not.toHaveProperty('sessionId');
    expect(JSON.stringify(actor)).not.toMatch(/verified|staff|session|control-plane:/);
  });
  it('keeps that attribution in the recorded ledger event and across a retry', async () => {
    const w = world();
    w.state.auditFails = true;
    expect(await w.bootstrap.grantManager({ operator: OPERATOR, operationId: 'boot-1', target: client('user_admin'), expiresAt: null })).toMatchObject({ kind: 'audit-pending' });
    const ledger = w.db.prepare("SELECT event_json FROM tenant_grant_operations WHERE operation_id = 'boot-1'").get() as { event_json: string };
    expect(JSON.parse(ledger.event_json).actor).toEqual({ kind: 'system', component: 'provisioning', operator: OPERATOR });
    w.state.auditFails = false;
    expect(await w.bootstrap.grantManager({ operator: OPERATOR, operationId: 'boot-1', target: client('user_admin'), expiresAt: null })).toMatchObject({ kind: 'applied', repeated: true });
    expect(bootstrapEvent(w).actor).toEqual({ kind: 'system', component: 'provisioning', operator: OPERATOR });
  });
});
