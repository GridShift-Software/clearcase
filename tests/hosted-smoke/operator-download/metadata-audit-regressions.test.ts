// Protected component regressions for metadata audit truthfulness. Synthetic existing doubles, not hosted acceptance.
import { describe, expect, it } from 'vitest';
import type { AuditEvent, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { CASE_A, identity, operateAuthority, seed, world } from './doubles.ts';
import { compose, dispatch } from './harness.ts';

const METADATA = [
  { route: 'list', action: 'operator.submission.list', kind: 'case' },
  { route: 'view', action: 'operator.submission.read', kind: 'submission' },
  { route: 'manifest', action: 'operator.submission.manifest', kind: 'submission' },
] as const;
type MetadataRoute = typeof METADATA[number]['route'];
const error = (code: string) => Object.assign(new Error(code), { code });
function call(route: MetadataRoute, operationId: string, who: Identity = identity()) {
  const tail = route === 'list' ? '' : `/${operationId}${route === 'manifest' ? '/manifest' : ''}`;
  const url = new URL(`https://client-a.clearcase.test/operator/submissions/${CASE_A}/finalized${tail}`);
  return dispatch(route, 'GET', { request: new Request(url), url, params: route === 'list' ? { caseId: CASE_A } : { caseId: CASE_A, operationId }, locals: { identity: who } });
}

describe.each(METADATA)('$route metadata audit', ({ route, action, kind }) => {
  it.each(['operate', 'session', 'read-original'] as const)('refuses late %s revocation during audit append without completed-success audit or data', async revokedAuthority => {
    const w = world(); const s = await seed(w);
    let revoked = false;
    let first: AuditEvent | undefined;
    const append = w.audit.append.bind(w.audit);
    w.audit.append = async e => {
      const ack = await append(e);
      first ??= structuredClone(e);
      revoked = true;
      return ack;
    };
    const base = identity(), operate = operateAuthority([CASE_A], w.operateCalls);
    let sessionChecks = 0, originalChecks = 0;
    const who: Identity = {
      ...base,
      checkRevocation: async () => {
        sessionChecks++;
        if (revoked && revokedAuthority === 'session') throw error('invalid-session');
        await base.checkRevocation();
      },
      authorize: async a => {
        originalChecks++;
        if (revoked && revokedAuthority === 'read-original') throw error('forbidden');
        await base.authorize(a);
      },
    };
    const retained: Promise<void>[] = [];
    compose({ ...w.ports, waitUntil: (work: Promise<void>) => retained.push(work), authorizeOperate: async (a: Parameters<typeof operate>[0]) => {
      await operate(a);
      if (revoked && revokedAuthority === 'operate') throw error('forbidden');
    } });
    const r = await call(route, s.operationId, who);
    expect(r.status).toBe(revokedAuthority === 'session' ? 401 : 404);
    expect(await r.json()).toEqual(revokedAuthority === 'session'
      ? { code: 'unauthenticated', message: 'Sign in to continue.' }
      : { code: 'not-found', message: 'Not found.' });
    expect(r.headers.get('x-clearcase-submission')).toBeNull();
    expect(r.headers.get('x-clearcase-manifest-sha256')).toBeNull();
    expect(r.headers.get('content-disposition')).toBeNull();
    expect(w.assets.calls).toEqual([]);
    expect(sessionChecks).toBe(2);
    expect(w.operateCalls).toHaveLength(revokedAuthority === 'session' ? 1 : 2);
    expect(originalChecks).toBe(revokedAuthority === 'read-original' ? 2 : 1);
    await Promise.all(retained);
    // The original immutable record cannot be a completed-success observation for a refused response.
    expect(w.audit.events.filter(e => e.action === action && e.outcome === 'succeeded')).toEqual([]);
    expect(w.audit.events[0]).toEqual(first);
    expect(w.audit.events).toHaveLength(2);
    expect(w.audit.events[0]).toMatchObject({ action: `${action}.intent`, outcome: 'succeeded', object: { kind, id: kind === 'case' ? CASE_A : s.operationId, caseId: CASE_A } });
    expect(w.audit.events[1]).toMatchObject({ eventId: `${first!.eventId}:refused`, action, outcome: 'refused', actor: first!.actor, object: first!.object });
    expect(retained).toHaveLength(1);
  });

  it('records intent only until validated metadata EOF, then retains one correlated completion', async () => {
    const w = world(); const s = await seed(w);
    const retained: Promise<void>[] = [];
    compose({ ...w.ports, waitUntil: (work: Promise<void>) => retained.push(work) });
    const r = await call(route, s.operationId);
    expect(r.status).toBe(200);
    const intent = structuredClone(w.audit.events[0]);
    expect(w.audit.events).toHaveLength(1);
    expect(intent).toMatchObject({ action: `${action}.intent`, outcome: 'succeeded' });
    expect(retained).toEqual([]);
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain(s.operationId);
    expect(w.audit.events).toEqual([intent]); // even the last expected chunk is not yet validated EOF
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await Promise.all(retained);
    expect(retained).toHaveLength(1);
    expect(w.audit.events[0]).toEqual(intent);
    expect(w.audit.events).toHaveLength(2);
    expect(w.audit.events[1]).toEqual({ ...intent, eventId: `${intent.eventId}:completed`, action, outcome: 'succeeded' });
    expect(w.operateCalls).toHaveLength(2);
    expect(w.assets.calls).toEqual([]);
  });

  it.each(['unread', 'after-chunk'] as const)('records one failure, never completion, when canceled %s', async at => {
    const w = world(); const s = await seed(w);
    const retained: Promise<void>[] = [];
    compose({ ...w.ports, waitUntil: (work: Promise<void>) => retained.push(work) });
    const r = await call(route, s.operationId);
    const intent = structuredClone(w.audit.events[0]);
    const reader = r.body!.getReader();
    if (at === 'after-chunk') expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await reader.cancel();
    await Promise.all(retained);
    expect(retained).toHaveLength(1);
    expect(w.audit.events).toEqual([intent, { ...intent, eventId: `${intent.eventId}:failed`, action, outcome: 'failed' }]);
  });

  it('keeps final refusal when the terminal audit append also fails', async () => {
    const w = world(); const s = await seed(w);
    let revoked = false;
    const append = w.audit.append.bind(w.audit);
    w.audit.append = async e => {
      if (!e.action.endsWith('.intent')) throw error('audit-unavailable');
      const ack = await append(e);
      revoked = true;
      return ack;
    };
    const retained: Promise<void>[] = [];
    compose({ ...w.ports, waitUntil: (work: Promise<void>) => retained.push(work), authorizeOperate: async () => {
      if (revoked) throw error('forbidden');
    } });
    const r = await call(route, s.operationId);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ code: 'not-found', message: 'Not found.' });
    await Promise.all(retained);
    expect(retained).toHaveLength(1);
    expect(w.audit.events.map(e => [e.action, e.outcome])).toEqual([[`${action}.intent`, 'succeeded']]);
  });

  it('leaves an orphan intent, never a manufactured completion, during a terminal-sink outage', async () => {
    const w = world(); const s = await seed(w);
    const retained: Promise<void>[] = [];
    compose({ ...w.ports, waitUntil: (work: Promise<void>) => retained.push(work) });
    const r = await call(route, s.operationId);
    w.audit.failNext = true;
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(s.operationId);
    await Promise.all(retained);
    expect(retained).toHaveLength(1);
    expect(w.audit.events.map(e => [e.action, e.outcome])).toEqual([[`${action}.intent`, 'succeeded']]);
  });

  it('records final authority-service failure as failed, with no metadata or success', async () => {
    const w = world(); const s = await seed(w);
    let checks = 0;
    compose({ ...w.ports, authorizeOperate: async () => {
      if (++checks === 2) throw error('identity-unavailable');
    } });
    const r = await call(route, s.operationId);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ code: 'identity-unavailable', message: 'Sign-in is unavailable. Try again shortly.' });
    const intent = w.audit.events[0];
    expect(w.audit.events).toEqual([
      { ...intent, action: `${action}.intent`, outcome: 'succeeded' },
      { ...intent, eventId: `${intent.eventId}:failed`, action, outcome: 'failed' },
    ]);
  });

  it.each([118, 119])('reserves terminal-id room for metadata intents of length %s', async size => {
    const w = world(); const s = await seed(w);
    const retained: Promise<void>[] = [];
    const eventId = 'x'.repeat(size);
    compose({ ...w.ports, newEventId: () => eventId, waitUntil: (work: Promise<void>) => retained.push(work) });
    const r = await call(route, s.operationId);
    expect(r.status).toBe(size === 118 ? 200 : 503);
    if (size === 119) {
      expect(await r.json()).toMatchObject({ code: 'audit-unavailable' });
      expect(w.audit.events).toEqual([]);
      expect(retained).toEqual([]);
    } else {
      expect(await r.text()).toContain(s.operationId);
      await Promise.all(retained);
      expect(w.audit.events.map(e => e.eventId)).toEqual([eventId, `${eventId}:completed`]);
      expect(w.audit.events[1].eventId).toHaveLength(128);
    }
  });
});
