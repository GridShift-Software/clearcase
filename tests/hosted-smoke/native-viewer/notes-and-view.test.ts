// Page notes (persisted through the user-work port) and the viewer page's load. The user-work port here is a unit double
// that follows the AsyncUserWork contract for rows (authority, expected versions, operation ids); it is not the durable
// production service, which stays UNRUN. Synthetic bytes only.
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import * as notes from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/notes/+server.ts';
import { load } from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/view/+page.server.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { createUnavailableServices } from '../../../src/lib/server/runtime/unavailable.ts';
import type { AsyncUserWork, Fields, WorkVersion, Written } from '../../../src/lib/server/runtime/contracts.ts';
import { bigPdf, ids, ORIGIN, world, type World } from './world.ts';

type Row = { rowId: string; store: string; fields: Fields; version: WorkVersion; caseId: string; operationId: string };
/** Row semantics of AsyncUserWork only: grant per case, expected-version checks, operation ids that repeat safely. */
function userWorkDouble(grants: Set<string>) {
  const rows = new Map<string, Row>(), ops = new Map<string, unknown>();
  let n = 0;
  const authorize = (caseId: string) => { if (!grants.has(caseId)) throw contractError('forbidden'); };
  const work = {
    async listRows(a: { caseId: string; store: string }) { authorize(a.caseId); return [...rows.values()].filter((r) => r.caseId === a.caseId && r.store === a.store).map((r) => ({ rowId: r.rowId, store: r.store, anchor: null, fields: { ...r.fields }, createdAt: '', updatedAt: '', intact: true, version: r.version })); },
    async putRow(a: { caseId: string; store: string; operationId: string; fields: Fields; expected: { kind: string } }): Promise<Written<{ rowId: string; repeated: boolean }>> {
      authorize(a.caseId);
      const seen = ops.get(a.operationId) as Written<{ rowId: string; repeated: boolean }> | undefined;
      if (seen && seen.kind === 'written') return { ...seen, value: { ...seen.value, repeated: true } };
      const rowId = `row-${++n}`, version = `v${n}` as WorkVersion;
      rows.set(rowId, { rowId, store: a.store, fields: { ...a.fields }, version, caseId: a.caseId, operationId: a.operationId });
      const out = { kind: 'written', value: { rowId, repeated: false }, version, caseRevision: 'r' as never } as Written<{ rowId: string; repeated: boolean }>;
      ops.set(a.operationId, out);
      return out;
    },
    async deleteRow(a: { caseId: string; store: string; rowId: string; expected: { kind: 'match'; version: WorkVersion } }): Promise<Written<boolean>> {
      authorize(a.caseId);
      const r = rows.get(a.rowId);
      if (!r || r.store !== a.store) return { kind: 'gone' };
      if (r.version !== a.expected.version) return { kind: 'stale' };
      rows.delete(a.rowId);
      return { kind: 'written', value: true, version: r.version, caseRevision: 'r' as never };
    },
  };
  return { work: work as unknown as AsyncUserWork, rows };
}

const kitCall = async (run: () => Promise<Response>) => {
  try { return await run(); } catch (e) { if (isHttpError(e)) return new Response(JSON.stringify(e.body), { status: e.status }); throw e; }
};
const params = (caseId: string, assetId: string) => ({ caseId, assetId });
function send(w: World, work: AsyncUserWork, method: 'GET' | 'POST' | 'DELETE', body: unknown, o: { origin?: string | null; type?: string | null; caseId?: string; assetId?: string } = {}) {
  const caseId = o.caseId ?? 'case-a', assetId = o.assetId ?? 'a1';
  const headers = new Headers();
  if (o.origin !== null) headers.set('origin', o.origin ?? ORIGIN);
  if (o.type !== null) headers.set('content-type', o.type ?? 'application/json');
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const url = new URL(`/cases/${caseId}/originals/${assetId}/notes`, ORIGIN);
  const request = new Request(url, { method, headers, ...(method === 'GET' || raw === undefined ? {} : { body: raw }) });
  return kitCall(() => (notes[method] as (e: never) => Promise<Response>)({ request, url, params: params(caseId, assetId), locals: { assets: w.assets, userWork: work } } as never));
}
let seq = 0;
const op = () => `op-${++seq}`;

async function fixture() {
  const w = world({ grants: ['case-a'] }), db = userWorkDouble(new Set(['case-a']));
  await w.upload('case-a', 'a1', bigPdf('notes'));
  await w.upload('case-a', 'a2', bigPdf('other doc'));
  return { w, ...db };
}

describe('page notes persist through user work and stay on their own original', () => {
  it('saves a note, lists it back for that original only, and records the original it was written against', async () => {
    const { w, work, rows } = await fixture();
    const r = await send(w, work, 'POST', { operationId: op(), page: 3, body: '  Check the date  ' });
    expect(r.status).toBe(201);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]!.fields).toMatchObject({ assetId: 'a1', page: 3, body: 'Check the date' });
    const list = (await (await send(w, work, 'GET', undefined)).json()) as { notes: { page: number; current: boolean }[] };
    expect(list.notes).toMatchObject([{ page: 3, current: true }]);
    expect(((await (await send(w, work, 'GET', undefined, { assetId: 'a2' })).json()) as { notes: unknown[] }).notes).toEqual([]);
  });

  it('flags a note whose original has since changed instead of presenting it as current', async () => {
    const { w, work, rows } = await fixture();
    await send(w, work, 'POST', { operationId: op(), page: 1, body: 'x' });
    [...rows.values()][0]!.fields.sha256 = '0'.repeat(64);
    const list = (await (await send(w, work, 'GET', undefined)).json()) as { notes: { current: boolean }[] };
    expect(list.notes[0]!.current).toBe(false);
  });

  it('repeats a retried operation without a second row', async () => {
    const { w, work, rows } = await fixture(), operationId = op();
    expect((await send(w, work, 'POST', { operationId, page: 1, body: 'once' })).status).toBe(201);
    expect((await send(w, work, 'POST', { operationId, page: 1, body: 'once' })).status).toBe(201);
    expect(rows.size).toBe(1);
  });

  it.each([[0], [-1], [1.5], [100001], ['3'], [null], [Number.NaN]])('refuses the page %j with 400 and writes nothing', async (page) => {
    const { w, work, rows } = await fixture();
    expect((await send(w, work, 'POST', { operationId: op(), page, body: 'x' })).status).toBe(400);
    expect(rows.size).toBe(0);
  });

  it.each([[''], ['   '], ['x'.repeat(2001)], ['bell\u0007'], ['flip\u202etxt'], [42], [null]])('refuses the body %j with 400 and writes nothing', async (body) => {
    const { w, work, rows } = await fixture();
    expect((await send(w, work, 'POST', { operationId: op(), page: 1, body })).status).toBe(400);
    expect(rows.size).toBe(0);
  });

  it('refuses a write from another origin, without an origin, or not as JSON, before any row or original is read', async () => {
    const { w, work, rows } = await fixture();
    const gets = w.bucket.gets;
    expect((await send(w, work, 'POST', { operationId: op(), page: 1, body: 'x' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await send(w, work, 'POST', { operationId: op(), page: 1, body: 'x' }, { origin: null })).status).toBe(403);
    expect((await send(w, work, 'POST', 'page=1&body=x', { type: 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await send(w, work, 'POST', 'not json')).status).toBe(400);
    expect((await send(w, work, 'POST', JSON.stringify({ operationId: op(), page: 1, body: 'x'.repeat(9000) }))).status).toBe(413);
    expect(rows.size).toBe(0);
    expect(w.bucket.gets).toBe(gets);
  });

  it('writes nothing for an original the caller cannot read, and answers 404 as for any absent original', async () => {
    const { w, work, rows } = await fixture();
    await w.upload('case-b', 'b1', bigPdf('b'));
    expect((await send(w, work, 'POST', { operationId: op(), page: 1, body: 'x' }, { caseId: 'case-b', assetId: 'b1' })).status).toBe(404);
    expect((await send(w, work, 'POST', { operationId: op(), page: 1, body: 'x' }, { assetId: 'nope' })).status).toBe(404);
    expect(rows.size).toBe(0);
  });

  it('answers a stale delete 409 and a delete of another original’s note 404, keeping both rows', async () => {
    const { w, work, rows } = await fixture();
    const made = (await (await send(w, work, 'POST', { operationId: op(), page: 1, body: 'keep' })).json()) as { note: { rowId: string; version: string } };
    expect((await send(w, work, 'DELETE', { operationId: op(), rowId: made.note.rowId, version: 'v-old' })).status).toBe(409);
    expect((await send(w, work, 'DELETE', { operationId: op(), rowId: made.note.rowId, version: made.note.version }, { assetId: 'a2' })).status).toBe(404);
    expect(rows.size).toBe(1);
    expect((await send(w, work, 'DELETE', { operationId: op(), rowId: made.note.rowId, version: made.note.version })).status).toBe(200);
    expect(rows.size).toBe(0);
  });

  it('answers 503, not an empty list, when user work is not connected, and never keeps the note anywhere else', async () => {
    const w = world(); await w.upload('case-a', 'a1', bigPdf('u'));
    const u = createUnavailableServices({ clientId: ids.clientA, now: () => new Date() });
    expect((await send(w, u.userWork, 'GET', undefined)).status).toBe(503);
    expect((await send(w, u.userWork, 'POST', { operationId: op(), page: 1, body: 'x' })).status).toBe(503);
  });

  it('answers a revoked caller 404 on reads and writes', async () => {
    const { w, work, rows } = await fixture();
    w.who.grants.delete('case-a');
    expect((await send(w, work, 'GET', undefined)).status).toBe(404);
    expect((await send(w, work, 'POST', { operationId: op(), page: 1, body: 'x' })).status).toBe(404);
    expect(rows.size).toBe(0);
  });
});

describe('the viewer page load', () => {
  const run = (w: World, work: AsyncUserWork, caseId = 'case-a', assetId = 'a1') => load({ params: params(caseId, assetId), url: new URL('https://case.test/view'), locals: { assets: w.assets, userWork: work } } as never).catch((e: unknown) => (isHttpError(e) ? { status: e.status } : Promise.reject(e)));

  it('passes the requested page from the URL to the viewer, including invalid values', async () => {
    const { w, work } = await fixture();
    for (const page of ['2', '0', '-1', '1.5', '41']) {
      const result = await load({ params: params('case-a', 'a1'), url: new URL(`https://case.test/view?page=${page}`), locals: { assets: w.assets, userWork: work } } as never);
      expect(result.requestedPage).toBe(page);
    }
  });

  it('offers the PDF viewer with only case/asset links: no object key, hash or storage id leaves the server', async () => {
    const { w, work } = await fixture();
    const data = (await run(w, work)) as { view: Record<string, unknown>; notesHref: string };
    expect(data.view).toMatchObject({ state: 'available', mode: 'pdf', srcHref: '/cases/case-a/originals/a1', downloadHref: '/cases/case-a/originals/a1?download=1' });
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toMatch(/orig\/|sha256|object_key|objectVersion/);
  });

  it('is download-only for a type the viewer does not render, and shows images natively', async () => {
    const { w, work } = await fixture();
    await w.upload('case-a', 'd1', new Uint8Array([0x50, 0x4b, 3, 4]), { filename: 'memo.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    await w.upload('case-a', 'i1', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { filename: 's.png', mediaType: 'image/png' });
    expect(((await run(w, work, 'case-a', 'd1')) as { view: { mode: string } }).view.mode).toBe('download');
    expect(((await run(w, work, 'case-a', 'i1')) as { view: { mode: string } }).view.mode).toBe('image');
  });

  it('shows a missing or changed original as that, never as a viewer', async () => {
    const { w, work } = await fixture();
    const key = [...w.bucket.objects.keys()].filter((k) => k.startsWith('orig/'))[0]!;
    w.bucket.objects.delete(key);
    const gone = (await Promise.all([run(w, work, 'case-a', 'a1'), run(w, work, 'case-a', 'a2')])) as { view: { state: string; reason?: string } }[];
    expect(gone.map((g) => g.view.reason).sort()).toEqual(['missing', undefined]);
    const other = [...w.bucket.objects.keys()].find((k) => k.startsWith('orig/'))!;
    w.bucket.tamper(other, (b) => { b[b.length - 20]! ^= 1; return b; });
    const both = (await Promise.all([run(w, work, 'case-a', 'a1'), run(w, work, 'case-a', 'a2')])) as { view: { state: string; reason?: string } }[];
    expect(both.every((b) => b.view.state === 'unavailable')).toBe(true);
    expect(both.map((b) => b.view.reason).sort()).toEqual(['changed', 'missing']);
  });

  it('answers 404 for an ungranted, revoked or malformed original', async () => {
    const { w, work } = await fixture();
    expect(await run(w, work, 'case-b', 'b1')).toEqual({ status: 404 });
    expect(await run(w, work, 'case-a', '..')).toEqual({ status: 404 });
    w.who.grants.delete('case-a');
    expect(await run(w, work, 'case-a', 'a1')).toEqual({ status: 404 });
  });

  it('keeps the document readable when user work is unavailable, marking only the notes', async () => {
    const { w } = await fixture();
    const u = createUnavailableServices({ clientId: ids.clientA, now: () => new Date() });
    const data = (await run(w, u.userWork)) as { view: { state: string }; notes: { state: string } };
    expect(data.view.state).toBe('available');
    expect(data.notes.state).toBe('unavailable');
  });

  it('answers 503 when the assets port is not connected', async () => {
    const { w, work } = await fixture();
    const u = createUnavailableServices({ clientId: ids.clientA, now: () => new Date() });
    expect(await load({ params: params('case-a', 'a1'), locals: { assets: u.assets, userWork: work } } as never).catch((e: unknown) => (isHttpError(e) ? { status: e.status } : Promise.reject(e)))).toEqual({ status: 503 });
    expect(w).toBeDefined();
  });
});
