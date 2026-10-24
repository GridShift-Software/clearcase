// GRS-137 single-file intake: the adverse HTTP contract of the hosted client intake routes. Synthetic PDFs only; the
// storage and identity sides are unit doubles (doubles.ts), so a pass here is component evidence, not a hosted PASS.
import { describe, expect, it } from 'vitest';
import type { CaseId, ClientId, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { CASE_A, CASE_B, CLIENT, MemoryOriginals, SqliteD1, hex, identity, syntheticPdf, trackedBody, uploadAuthority } from './doubles.ts';
import { MIGRATIONS, compose, dispatch, repositoryFor } from './harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const BUDGET = { maxMetadataBytes: 2048, maxFileBytes: 4096 };

function world(o: { upload?: readonly CaseId[]; configured?: boolean; budget?: typeof BUDGET | null } = {}) {
  const db = new SqliteD1(MIGRATIONS), originals = new MemoryOriginals(), authorizeCalls: unknown[] = [];
  const ports = {
    clientId: CLIENT,
    budget: o.budget === undefined ? BUDGET : o.budget,
    authorizeUpload: uploadAuthority(o.upload ?? [CASE_A], authorizeCalls),
    originals,
    repository: repositoryFor(db),
    now: () => new Date('2026-10-24T12:00:00.000Z'),
  };
  compose(o.configured === false ? null : ports);
  return { db, originals, authorizeCalls, ports };
}

let seq = 0;
const op = () => `op-${String(++seq).padStart(4, '0')}-0b7c2f3e1d2a4c5b`;
type Init = { origin?: string | null; contentType?: string; body?: BodyInit | ReadableStream<Uint8Array>; who?: Identity };
function event(path: string, method: string, init: Init, params: Record<string, string>) {
  const url = new URL(path, ORIGIN), headers = new Headers();
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  if (init.contentType) headers.set('content-type', init.contentType);
  const request = new Request(url, { method, headers, body: init.body as BodyInit, ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
  return { request, url, params, locals: { identity: init.who ?? identity() } };
}
const declare = (caseId: string, meta: unknown, init: Init = {}) =>
  dispatch('submissions', 'POST', event(`/client/intake/${caseId}/submissions`, 'POST', { contentType: 'application/json', body: JSON.stringify(meta), ...init }, { caseId }));
const put = (caseId: string, operationId: string, body: Uint8Array | ReadableStream<Uint8Array>, init: Init = {}) =>
  dispatch('submission', 'PUT', event(`/client/intake/${caseId}/submissions/${operationId}`, 'PUT', { contentType: 'application/pdf', body: body as BodyInit, ...init }, { caseId, operationId }));
const read = (caseId: string, operationId: string, who?: Identity) =>
  dispatch('submission', 'GET', event(`/client/intake/${caseId}/submissions/${operationId}`, 'GET', { who }, { caseId, operationId }));
const list = (caseId: string, who?: Identity) => dispatch('submissions', 'GET', event(`/client/intake/${caseId}/submissions`, 'GET', { who }, { caseId }));
const meta = (bytes: Uint8Array, operationId: string, path = 'Letters/claim.pdf') => ({ operationId, path, size: bytes.byteLength, sha256: hex(bytes), mediaType: 'application/pdf' });
const code = async (r: Response) => ((await r.json()) as { code: string }).code;

async function finalized(caseId: CaseId, bytes = syntheticPdf()) {
  const operationId = op();
  expect((await declare(caseId, meta(bytes, operationId))).status).toBe(201);
  const r = await put(caseId, operationId, bytes);
  return { operationId, r, body: (await r.clone().json()) as { stage: string; manifest: Manifest } };
}
type Manifest = { revisionId: string; sequence: number; caseId: string; clientId: string; files: { path: string; filename: string; size: number; sha256: string; mediaType: string; assetId: string }[] };

describe('authority is decided before any body byte, row or object', () => {
  it('refuses an anonymous caller with 401 and never pulls the metadata body', async () => {
    const w = world(), bytes = syntheticPdf(), t = trackedBody(new TextEncoder().encode(JSON.stringify(meta(bytes, op()))));
    const r = await declare('case-a', {}, { body: t.stream, who: identity({ kind: 'anonymous' }) });
    expect(r.status).toBe(401);
    expect(await code(r)).toBe('unauthenticated');
    expect(t.state.pulled).toBe(0);
    expect(w.authorizeCalls).toHaveLength(0);
    expect(w.originals.calls).toEqual([]);
  });

  it('refuses a session of another client with 401 wrong-client', async () => {
    const w = world();
    const r = await declare('case-a', meta(syntheticPdf(), op()), { who: identity({ clientId: 'client-b' as ClientId }) });
    expect(r.status).toBe(401);
    expect(await code(r)).toBe('wrong-client');
    expect(w.originals.calls).toEqual([]);
  });

  it('refuses a case the upload capability does not cover with 403, even when the caller may read it', async () => {
    const w = world({ upload: [CASE_A] }), t = trackedBody(new TextEncoder().encode(JSON.stringify(meta(syntheticPdf(), op()))));
    const r = await declare('case-b', {}, { body: t.stream, who: identity({ read: [CASE_A, CASE_B] }) });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('forbidden');
    expect(t.state.pulled).toBe(0);
    expect(w.originals.calls).toEqual([]);
  });

  it('asks the separate upload capability with the trusted client and the URL case, never a body-claimed client', async () => {
    const w = world(), bytes = syntheticPdf();
    const r = await declare('case-a', { ...meta(bytes, op()), clientId: 'client-b' });
    expect(r.status).toBe(422);
    expect(w.authorizeCalls).toEqual([expect.objectContaining({ clientId: CLIENT, caseId: CASE_A })]);
  });

  it('refuses a cross-origin or originless write with 403 before authorization', async () => {
    const w = world();
    for (const origin of ['https://evil.test', null]) {
      const r = await declare('case-a', meta(syntheticPdf(), op()), { origin });
      expect(r.status).toBe(403);
      expect(await code(r)).toBe('cross-origin');
    }
    expect(w.authorizeCalls).toHaveLength(0);
  });

  it('answers 503 when the parent has not composed the intake ports, and when the trusted size budget is missing', async () => {
    world({ configured: false });
    const a = await declare('case-a', meta(syntheticPdf(), op()));
    expect(a.status).toBe(503);
    expect(await code(a)).toBe('intake-unavailable');
    const w = world({ budget: null }), t = trackedBody(new TextEncoder().encode('{}'));
    const b = await declare('case-a', {}, { body: t.stream });
    expect(b.status).toBe(503);
    expect(t.state.pulled).toBe(0);
    expect(w.authorizeCalls).toHaveLength(0);
  });

  it('a file PUT for case-a\'s operation through case-b is refused without reading the body', async () => {
    const w = world({ upload: [CASE_A] }), bytes = syntheticPdf(), operationId = op();
    expect((await declare('case-a', meta(bytes, operationId))).status).toBe(201);
    const t = trackedBody(bytes);
    const r = await put('case-b', operationId, t.stream);
    expect(r.status).toBe(403);
    expect(t.state.pulled).toBe(0);
    expect(w.originals.calls).toEqual(['declare']);
  });
});

describe('bounded metadata and raw body', () => {
  it('stops reading metadata past the trusted budget, whatever content-length says', async () => {
    const w = world(), big = new TextEncoder().encode(JSON.stringify({ ...meta(syntheticPdf(), op()), pad: 'x'.repeat(10_000) })), t = trackedBody(big, { chunk: 256 });
    const r = await declare('case-a', {}, { body: t.stream });
    expect(r.status).toBe(413);
    expect(t.state.pulled).toBeLessThanOrEqual(BUDGET.maxMetadataBytes + 256);
    expect(w.originals.calls).toEqual([]);
  });

  it('refuses a declared size over the trusted file budget before any storage call', async () => {
    const w = world();
    const r = await declare('case-a', { ...meta(syntheticPdf(), op()), size: BUDGET.maxFileBytes + 1 });
    expect(r.status).toBe(413);
    expect(w.originals.calls).toEqual([]);
  });

  it('stops reading a file body that runs past its declared size', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    await declare('case-a', meta(bytes, operationId));
    const longer = new Uint8Array(BUDGET.maxFileBytes * 4); longer.set(bytes);
    const t = trackedBody(longer, { chunk: 64 });
    const r = await put('case-a', operationId, t.stream);
    expect(r.status).toBe(413);
    expect(t.state.pulled).toBeLessThanOrEqual(bytes.byteLength + 64);
    expect(w.originals.calls).toEqual(['declare']);
  });

  it.each([
    ['/abs/claim.pdf', 'absolute'], ['../claim.pdf', 'traversal'], ['a/./claim.pdf', 'dot segment'], ['a\\claim.pdf', 'backslash'],
    ['a//claim.pdf', 'empty segment'], ['a/cla\u0007im.pdf', 'control'], ['a/inv\u202efdp.pdf', 'bidi override'], ['C:/claim.pdf', 'drive'],
    ['claim.exe', 'not a pdf name'], ['a/claim.pdf ', 'trailing space'],
  ])('refuses the path %j (%s) with 422 before any storage call', async (path) => {
    const w = world(), bytes = syntheticPdf();
    const r = await declare('case-a', meta(bytes, op(), path));
    expect(r.status).toBe(422);
    expect(await code(r)).toBe('invalid-path');
    expect(w.originals.calls).toEqual([]);
  });

  it('refuses a non-PDF media type and an unknown metadata field', async () => {
    world();
    const bytes = syntheticPdf();
    expect((await declare('case-a', { ...meta(bytes, op()), mediaType: 'text/html' })).status).toBe(422);
    expect((await declare('case-a', { ...meta(bytes, op()), bucket: 'orig/x' })).status).toBe(422);
  });
});

describe('the bytes are verified, not the declaration', () => {
  it('refuses bytes that do not hash to the declaration and stores nothing', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    await declare('case-a', meta(bytes, operationId));
    const corrupt = new Uint8Array(bytes); corrupt[20] ^= 0xff;
    const r = await put('case-a', operationId, corrupt);
    expect(r.status).toBe(422);
    expect(await code(r)).toBe('digest-mismatch');
    expect(w.originals.objects.size).toBe(0);
    expect(w.originals.calls).toEqual(['declare']);
  });

  it('refuses bytes that are not a PDF even when the declaration matches them', async () => {
    const w = world(), html = new TextEncoder().encode('<html>not a pdf</html>'), operationId = op();
    await declare('case-a', meta(html, operationId));
    const r = await put('case-a', operationId, html);
    expect(r.status).toBe(422);
    expect(await code(r)).toBe('not-a-pdf');
    expect(w.originals.objects.size).toBe(0);
  });

  it('refuses a file PUT for an operation that was never declared', async () => {
    world();
    const r = await put('case-a', op(), syntheticPdf());
    expect(r.status).toBe(404);
    expect(await code(r)).toBe('not-declared');
  });
});

describe('interruption and retry recover the same revision', () => {
  it('an interrupted body stores nothing; the whole retry then finalizes', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    await declare('case-a', meta(bytes, operationId));
    const cut = await put('case-a', operationId, trackedBody(bytes, { cutAt: 30 }).stream);
    expect(cut.status).toBe(400);
    expect(await code(cut)).toBe('incomplete-body');
    expect(w.originals.objects.size).toBe(0);
    const retry = await put('case-a', operationId, bytes);
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { stage: string }).stage).toBe('finalized');
  });

  it('a storage fault before finalize answers 503 and never claims success', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    await declare('case-a', meta(bytes, operationId));
    w.originals.failNext = 'finalize';
    const r = await put('case-a', operationId, bytes);
    expect(r.status).toBe(503);
    expect(((await (await read('case-a', operationId)).json()) as { stage: string }).stage).not.toBe('finalized');
    expect((await put('case-a', operationId, bytes)).status).toBe(201);
  });

  it('a manifest write fault after the original is finalized answers 503; the retry returns the one revision', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    await declare('case-a', meta(bytes, operationId));
    w.db.failNext = /INSERT INTO submissions_revision/;
    const r = await put('case-a', operationId, bytes);
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('manifest-unrecorded');
    const retry = await put('case-a', operationId, bytes);
    expect(retry.status).toBe(201);
    const body = (await retry.json()) as { manifest: Manifest };
    expect(body.manifest.sequence).toBe(1);
    expect(((await (await list('case-a')).json()) as { submissions: unknown[] }).submissions).toHaveLength(1);
  });
});

describe('a finalized submission is immutable', () => {
  it('replaying the finalized PUT returns the identical stored manifest', async () => {
    world();
    const bytes = syntheticPdf(), first = await finalized(CASE_A, bytes);
    expect(first.r.status).toBe(201);
    const again = await put('case-a', first.operationId, bytes);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { manifest: Manifest }).manifest).toEqual(first.body.manifest);
    const m = first.body.manifest;
    expect(m).toMatchObject({ caseId: 'case-a', clientId: 'client-a', sequence: 1 });
    expect(m.files).toEqual([{ path: 'Letters/claim.pdf', filename: 'claim.pdf', size: bytes.byteLength, sha256: hex(bytes), mediaType: 'application/pdf', assetId: expect.any(String) }]);
  });

  it('changed bytes or changed metadata under a finalized operation are refused, and the manifest is unchanged', async () => {
    world();
    const bytes = syntheticPdf(), first = await finalized(CASE_A, bytes), other = syntheticPdf('two');
    expect((await put('case-a', first.operationId, other)).status).toBe(422);
    const re = await declare('case-a', meta(other, first.operationId));
    expect(re.status).toBe(409);
    expect(await code(re)).toBe('operation-reused');
    const now = (await (await read('case-a', first.operationId)).json()) as { manifest: Manifest };
    expect(now.manifest).toEqual(first.body.manifest);
  });

  it('a file sent after finalization is a new revision; the first is untouched', async () => {
    world();
    const first = await finalized(CASE_A, syntheticPdf('one')), second = await finalized(CASE_A, syntheticPdf('two'));
    expect(second.r.status).toBe(201);
    expect(second.body.manifest.sequence).toBe(2);
    expect(second.body.manifest.revisionId).not.toBe(first.body.manifest.revisionId);
    expect(((await (await read('case-a', first.operationId)).json()) as { manifest: Manifest }).manifest).toEqual(first.body.manifest);
  });
});

describe('case-authorized manifest and download handoff', () => {
  it('shows the finalized manifest with a handoff through the case originals route and honest stages', async () => {
    world();
    const f = await finalized(CASE_A);
    const r = await read('case-a', f.operationId);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stage: string; results: string; handoff: { href: string }[] };
    expect(body.stage).toBe('finalized');
    expect(body.results).toBe('none');
    expect(body.handoff).toEqual([{ path: 'Letters/claim.pdf', href: `/cases/case-a/originals/${f.body.manifest.files[0].assetId}` }]);
  });

  it('reports a declared but unsent file as received, not finalized', async () => {
    world();
    const operationId = op();
    await declare('case-a', meta(syntheticPdf(), operationId));
    const body = (await (await read('case-a', operationId)).json()) as { stage: string; manifest: unknown };
    expect(body.stage).toBe('received');
    expect(body.manifest).toBeNull();
  });

  it('hides another case\'s submission: same 404 as an unknown one', async () => {
    world({ upload: [CASE_A, CASE_B] });
    const f = await finalized(CASE_A);
    const cross = await read('case-b', f.operationId, identity({ read: [CASE_A, CASE_B] }));
    expect(cross.status).toBe(404);
    const unread = await read('case-a', f.operationId, identity({ read: [CASE_B] }));
    expect(unread.status).toBe(404);
    expect((await list('case-a', identity({ kind: 'anonymous' }))).status).toBe(401);
  });
});
