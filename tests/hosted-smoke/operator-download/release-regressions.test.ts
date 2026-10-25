// Component regressions only: synthetic bytes and existing doubles, no provider boundary.
import { describe, expect, it } from 'vitest';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { createOperatorDownloadController } from '../../../src/lib/submissions/download/controller.ts';
import type { OperatorDownloadPorts } from '../../../src/lib/submissions/download/ports.ts';
import { CASE_A, identity, seed, world } from './doubles.ts';

const error = (code: string) => Object.assign(new Error(code), { code });
function request(operationId: string, headers: Record<string, string> = {}, who: Identity = identity(), method = 'GET') {
  const url = new URL(`https://client-a.clearcase.test/operator/submissions/${CASE_A}/finalized/${operationId}/download`);
  return { request: new Request(url, { method, headers }), url, params: { caseId: CASE_A, operationId }, identity: who };
}
const controller = (ports: unknown) => createOperatorDownloadController(ports as OperatorDownloadPorts);

// Explicit terminal events keep the original action; intent is not successful delivery.
const terminals = (w: ReturnType<typeof world>) => w.audit.events.filter(e => e.action === 'operator.submission.download');

describe('release-time authority on unchanged callers', () => {
  it.each(['list', 'read', 'manifest', 'download'] as const)('rechecks operate after the last audit/storage await for %s', async route => {
    const w = world(); const s = await seed(w);
    let granted = true;
    const append = w.audit.append.bind(w.audit);
    w.audit.append = async e => { const ack = await append(e); granted = false; return ack; };
    const ports = { ...w.ports, authorizeOperate: async () => { if (!granted) throw error('forbidden'); } };
    const r = await controller(ports)[route](request(s.operationId));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ code: 'not-found', message: 'Not found.' });
    expect(r.headers.get('x-clearcase-submission')).toBeNull();
    expect(w.assets.pulled).toBe(0);
  });
  it.each(['session', 'read-original', 'operate'] as const)('cancels the unread upstream body when %s is revoked during get', async kind => {
    const w = world(); const s = await seed(w);
    let revoked = false, canceled = 0;
    const who = identity();
    const realCheck = who.checkRevocation.bind(who), realAuthorize = who.authorize.bind(who);
    const changed: Identity = { ...who,
      checkRevocation: async () => { if (revoked && kind === 'session') throw error('invalid-session'); await realCheck(); },
      authorize: async a => { if (revoked && kind === 'read-original') throw error('forbidden'); await realAuthorize(a); },
    };
    w.assets.get = async () => {
      revoked = true;
      return new Response(new ReadableStream({ cancel: () => { canceled++; } }, { highWaterMark: 0 }), { headers: { 'content-length': String(s.bytes.length) } });
    };
    const ports = { ...w.ports, authorizeOperate: async () => { if (revoked && kind === 'operate') throw error('forbidden'); } };
    const r = await controller(ports).download(request(s.operationId, {}, changed));
    expect(r.status).toBe(kind === 'session' ? 401 : 404);
    expect(canceled).toBe(1);
    expect(w.assets.pulled).toBe(0);
    expect(terminals(w).map(e => e.outcome)).toEqual(['failed']);
  });
});

describe('the response interval belongs to the requested range', () => {
  it.each(['bytes=10-', 'bytes=-10', 'bytes=10-999999'])('keeps normalized open, suffix and clamped ranges: %s', async range => {
    const w = world(); const s = await seed(w);
    const r = await controller(w.ports).download(request(s.operationId, { range }));
    expect(r.status).toBe(206);
    const start = range === 'bytes=-10' ? s.bytes.length - 10 : 10;
    expect(r.headers.get('content-range')).toBe(`bytes ${start}-${s.bytes.length - 1}/${s.bytes.length}`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(s.bytes.slice(start));
  });
  it('keeps an If-Range full-200 fallback', async () => {
    const w = world(); const s = await seed(w);
    const get = w.assets.get.bind(w.assets);
    w.assets.get = a => get({ ...a, request: { ...a.request, range: null } });
    const r = await controller(w.ports).download(request(s.operationId, { range: 'bytes=0-9', 'if-range': '"old"' }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-range')).toBeNull();
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(s.bytes);
  });
  it.each([
    ['bytes=0-9', 206, 'bytes 30-39/SIZE', '10'],
    ['bytes=-10', 206, 'bytes 0-9/SIZE', '10'],
    ['bytes=10-', 206, 'bytes 0-9/SIZE', '10'],
    ['bytes=0-9', 206, 'bytes 0-9/SIZE', '9'],
    ['bytes=0-9', 200, 'bytes 0-9/SIZE', 'SIZE'],
    ['', 206, 'bytes 0-9/SIZE', '10'],
    ['', 416, 'bytes */SIZE', '0'],
    ['bytes=0-9', 416, 'bytes */SIZE', '0'],
    ['bytes=999999-', 416, 'bytes */999999', '0'],
    ['bytes=999999-', 416, 'bytes */SIZE', '7'],
    ['bytes=999999-', 206, 'bytes 0-9/SIZE', '10'],
  ] as const)('refuses range/status/interval/length contradiction %s %s %s %s', async (range, status, interval, length) => {
    const w = world(); const s = await seed(w);
    let canceled = 0;
    w.assets.get = async () => new Response(new ReadableStream({ cancel: () => { canceled++; } }, { highWaterMark: 0 }), {
      status, headers: { 'content-range': interval.replace('SIZE', String(s.bytes.length)), 'content-length': length.replace('SIZE', String(s.bytes.length)) },
    });
    const r = await controller(w.ports).download(request(s.operationId, range ? { range } : {}));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'asset-unavailable' });
    expect(canceled).toBe(1);
    expect(terminals(w).map(e => e.outcome)).toEqual(['failed']);
  });
  it.each(['bytes=-0', 'bytes=999999-', 'bytes=20-10'])('records unsatisfiable %s as refused, not downloaded', async range => {
    const w = world(); const s = await seed(w);
    const r = await controller(w.ports).download(request(s.operationId, { range }));
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${s.bytes.length}`);
    expect(terminals(w).map(e => e.outcome)).toEqual(['refused']);
  });
});

describe('immutable correlated audit lifecycle', () => {
  it('retains one terminal audit through the parent request lifetime hook', async () => {
    const w = world(); const s = await seed(w);
    const retained: Promise<void>[] = [];
    const r = await controller({ ...w.ports, waitUntil: (p: Promise<void>) => retained.push(p) }).download(request(s.operationId));
    expect(retained).toEqual([]);
    await r.arrayBuffer();
    await Promise.all(retained);
    expect(retained).toHaveLength(1);
    expect(terminals(w).map(e => e.outcome)).toEqual(['succeeded']);
  });
  it('fails closed before get if a custom event id cannot fit a terminal suffix', async () => {
    const w = world(); const s = await seed(w);
    const r = await controller({ ...w.ports, newEventId: () => 'x'.repeat(119) }).download(request(s.operationId));
    expect(r.status).toBe(503);
    expect(w.assets.calls).toEqual(['metadata']);
    expect(w.audit.events).toEqual([]);
  });
  it('audits acquisition failures without reporting a successful download', async () => {
    const w = world(); const s = await seed(w);
    w.assets.get = async () => { throw error('asset-unavailable'); };
    const r = await controller(w.ports).download(request(s.operationId));
    expect(r.status).toBe(503);
    expect(terminals(w).map(e => e.outcome)).toEqual(['failed']);
  });
  it('cancels a pending read once, releasing the upstream reader and correlating failure', async () => {
    const w = world(); const s = await seed(w);
    let started!: () => void, canceled = 0;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const upstream = new ReadableStream<Uint8Array>({
      pull: () => { started(); return new Promise<void>(() => {}); },
      cancel: () => { canceled++; },
    }, { highWaterMark: 0 });
    w.assets.get = async () => new Response(upstream, { headers: { 'content-length': String(s.bytes.length) } });
    const r = await controller(w.ports).download(request(s.operationId));
    const reader = r.body!.getReader();
    const read = reader.read();
    await pending;
    await reader.cancel();
    expect(await read).toEqual({ done: true, value: undefined });
    expect(canceled).toBe(1);
    expect(upstream.locked).toBe(false);
    expect(terminals(w).map(e => e.outcome)).toEqual(['failed']);
  });
  it('still records failure if upstream cancellation itself rejects', async () => {
    const w = world(); const s = await seed(w);
    w.assets.get = async () => new Response(new ReadableStream({ cancel: () => { throw new Error('synthetic cancel error'); } }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(s.bytes.length) },
    });
    const r = await controller(w.ports).download(request(s.operationId));
    await expect(r.body!.cancel()).rejects.toThrow('synthetic cancel error');
    expect(terminals(w).map(e => e.outcome)).toEqual(['failed']);
  });
  it('records intent before reading but no delivery success until exact EOF', async () => {
    const w = world(); const s = await seed(w);
    const retained: Promise<void>[] = [];
    const r = await controller({ ...w.ports, waitUntil: (p: Promise<void>) => retained.push(p) }).download(request(s.operationId));
    expect(w.audit.events.map(e => e.action)).toEqual(['operator.submission.download.intent']);
    const intent = structuredClone(w.audit.events[0]);
    const reader = r.body!.getReader();
    await reader.read();
    expect(terminals(w)).toEqual([]);
    while (!(await reader.read()).done) { /* consume to validated EOF */ }
    await Promise.all(retained); // terminal append is retained after output closure, never before EOF
    expect(w.audit.events[0]).toEqual(intent);
    expect(terminals(w)).toHaveLength(1);
    expect(terminals(w)[0]).toMatchObject({ eventId: `${intent.eventId}:completed`, action: 'operator.submission.download', outcome: 'succeeded', object: intent.object, actor: intent.actor });
  });
  it.each(['short', 'long', 'read-error', 'cancel'] as const)('records exactly one correlated failure for %s, never completion', async kind => {
    const w = world(); const s = await seed(w);
    let canceled = 0;
    if (kind === 'short') w.assets.tamper.shortBytes = 7;
    if (kind === 'long') w.assets.tamper.extraBytes = 7;
    if (kind === 'read-error' || kind === 'cancel') {
      w.assets.get = async () => new Response(new ReadableStream<Uint8Array>({
        pull: c => { if (kind === 'read-error') throw new Error('synthetic reader failure'); c.enqueue(s.bytes.slice(0, 8)); },
        cancel: () => { canceled++; },
      }, { highWaterMark: 0 }), { headers: { 'content-length': String(s.bytes.length) } });
    }
    const r = await controller(w.ports).download(request(s.operationId));
    const intent = structuredClone(w.audit.events[0]);
    if (kind === 'cancel') { const reader = r.body!.getReader(); await reader.read(); await reader.cancel(); expect(canceled).toBe(1); }
    else await expect(r.arrayBuffer()).rejects.toThrow();
    expect(w.audit.events[0]).toEqual(intent);
    expect(terminals(w)).toHaveLength(1);
    expect(terminals(w)[0]).toMatchObject({ eventId: `${intent.eventId}:failed`, outcome: 'failed', object: intent.object, actor: intent.actor });
  });
  it('does not turn a best-effort failure-audit outage into success', async () => {
    const w = world(); const s = await seed(w);
    w.assets.tamper.shortBytes = 7;
    const r = await controller(w.ports).download(request(s.operationId));
    w.audit.failNext = true;
    await expect(r.arrayBuffer()).rejects.toThrow();
    expect(terminals(w)).toEqual([]);
    expect(w.audit.events.map(e => e.action)).toEqual(['operator.submission.download.intent']);
  });
  it('distinguishes two simultaneous actors by event id, including a canceled download', async () => {
    const w = world(); const s = await seed(w);
    const c = controller(w.ports);
    const second = identity();
    if (second.kind !== 'verified') throw new Error('expected synthetic staff identity');
    const other: Identity = { ...second, principal: { ...second.principal, subject: 'operator-2' } };
    const [a, b] = await Promise.all([c.download(request(s.operationId)), c.download(request(s.operationId, {}, other))]);
    await Promise.all([a.arrayBuffer(), b.body!.cancel()]);
    const intents = w.audit.events.filter(e => e.action.endsWith('.intent'));
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map(e => e.eventId)).size).toBe(2);
    expect(new Set(intents.map(e => e.actor.principal?.subject))).toEqual(new Set(['operator-1', 'operator-2']));
    expect(terminals(w).map(e => e.outcome).sort()).toEqual(['failed', 'succeeded']);
    for (const intent of intents) {
      const matching = terminals(w).filter(e => e.eventId.startsWith(`${intent.eventId}:`));
      expect(matching).toHaveLength(1);
      expect(matching[0].actor).toEqual(intent.actor);
    }
  });
  it('separately names HEAD inspection, not a completed byte download', async () => {
    const w = world(); const s = await seed(w);
    const r = await controller(w.ports).download(request(s.operationId, {}, identity(), 'HEAD'));
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    expect(w.assets.pulled).toBe(0);
    expect(terminals(w)).toEqual([]);
    expect(w.audit.events.map(e => [e.action, e.outcome])).toEqual([
      ['operator.submission.download.head.intent', 'succeeded'], ['operator.submission.download.head', 'succeeded'],
    ]);
  });
});
