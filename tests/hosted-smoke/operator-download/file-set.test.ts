// U16: the operator download serves a sealed multi-file submission as its exact manifest plus one link per file.
// Synthetic PDFs only; storage, assets, capability and audit are unit doubles, so a pass here is component evidence.
import { describe, expect, it } from 'vitest';
import { createIntakeController } from '../../../src/lib/submissions/controller.ts';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';
import { MemoryOriginals, identity as clientIdentity } from '../intake/doubles.ts';
import { CASE_A, CLIENT, identity, seed, sha, syntheticPdf, world, type World } from './doubles.ts';
import { compose, dispatch, type Route } from './harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const SET = 'set-0001-0b7c2f3e1d2a4c5b';
const base = (operationId?: string) => `/operator/submissions/${CASE_A}/finalized${operationId ? `/${operationId}` : ''}`;
function call(route: Route, operationId: string, query = '') {
  const path = { list: base(), view: base(operationId), manifest: `${base(operationId)}/manifest`, download: `${base(operationId)}/download` }[route];
  const url = new URL(`${path}${query}`, ORIGIN);
  return dispatch(route, 'GET', { request: new Request(url), url, params: route === 'list' ? { caseId: CASE_A } : { caseId: CASE_A, operationId }, locals: { identity: identity() } });
}

/** A set supplied through the real intake controller over the same D1, its bytes mirrored into the assets stand-in. */
async function supplySet(w: World, n: number, o: { seal?: boolean } = {}) {
  const intake = createIntakeController({ clientId: CLIENT, budget: { maxMetadataBytes: 2048, maxFileBytes: 4096 }, authorizeUpload: async () => {}, originals: new MemoryOriginals(), repository: w.repo, now: () => new Date('2026-10-27T09:00:00.000Z'), sealStep: { files: 2, bytes: 1 << 30, ms: 60_000 } } as never);
  const req = (path: string, method: string, params: Record<string, string>, body: BodyInit, type: string) => {
    const url = new URL(`/client/intake/${CASE_A}/sets${path}`, ORIGIN);
    return { request: new Request(url, { method, headers: { origin: ORIGIN, 'content-type': type }, body }), url, params: { caseId: CASE_A, ...params }, identity: clientIdentity() };
  };
  const fs = Array.from({ length: n }, (_, i) => ({ operationId: `fil${String(i).padStart(4, '0')}-0b7c2f3e1d2a4c5b`, path: `Bundle/doc ${i}.pdf`, bytes: syntheticPdf(`set-${i}`) }));
  const total = fs.reduce((t, f) => t + f.bytes.byteLength, 0);
  expect((await intake.openSet(req('', 'POST', {}, JSON.stringify({ setId: SET, fileCount: n, totalBytes: total }), 'application/json'))).status).toBe(201);
  for (const f of fs) {
    expect((await intake.declareSetFile(req(`/${SET}/files`, 'POST', { setId: SET }, JSON.stringify({ operationId: f.operationId, path: f.path, size: f.bytes.byteLength, sha256: sha(f.bytes), mediaType: 'application/pdf' }), 'application/json'))).status).toBe(201);
    expect((await intake.uploadSetFile(req(`/${SET}/files/${f.operationId}`, 'PUT', { setId: SET, operationId: f.operationId }, f.bytes as BodyInit, 'application/pdf'))).status).toBe(201);
    w.assets.objects.set(`${CASE_A}/sub-${f.operationId}`, f.bytes);
    w.assets.names.set(`${CASE_A}/sub-${f.operationId}`, f.path.split('/').pop()!);
  }
  const digest = await fileSetDigest(fs.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha(f.bytes) })));
  if (o.seal !== false) for (let r = await intake.sealSet(req(`/${SET}/seal`, 'POST', { setId: SET }, JSON.stringify({ filesSha256: digest }), 'application/json')); r.status === 202;)
    r = await intake.sealSet(req(`/${SET}/seal`, 'POST', { setId: SET }, JSON.stringify({ filesSha256: digest }), 'application/json'));
  return { fs, digest };
}
type View = { kind: string; operationId: string; sequence: number; manifestSha256: string; filesSha256: string | null; fileCount: number; downloadHref: string | null; manifestHref: string; files: { path: string; sha256: string; downloadHref: string }[] };

describe('operator download of a multi-file submission', () => {
  it('lists the sealed set with its exact manifest and one download link per file, beside a single-file submission', async () => {
    const w = world(); compose(w.ports);
    const one = await seed(w);
    const { fs, digest } = await supplySet(w, 3);
    const l = (await (await call('list', '')).json()) as { submissions: View[]; pendingCount: number };
    expect(l.pendingCount).toBe(0);
    expect(l.submissions.map((s) => [s.kind, s.operationId, s.sequence])).toEqual([['file', one.operationId, 1], ['set', SET, 2]]);
    const set = l.submissions[1]!;
    expect(set).toMatchObject({ fileCount: 3, filesSha256: digest, downloadHref: null });
    expect(set.files.map((f) => f.downloadHref)).toEqual([...fs].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${base(SET)}/download?file=sub-${f.operationId}`));

    const manifest = await call('manifest', SET);
    const bytes = new Uint8Array(await manifest.arrayBuffer());
    expect(sha(bytes)).toBe(set.manifestSha256);
    expect((JSON.parse(new TextDecoder().decode(bytes)) as { files: unknown[] }).files).toHaveLength(3);

    for (const f of fs) {
      const r = await call('download', SET, `?file=sub-${f.operationId}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-clearcase-sha256')).toBe(sha(f.bytes));
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(f.bytes);
    }
    expect((await call('download', SET)).status).toBe(404);
    expect((await call('download', SET, '?file=sub-unknown')).status).toBe(404);
    const single = await call('download', one.operationId);
    expect(new Uint8Array(await single.arrayBuffer())).toEqual(one.bytes);
  });

  it('serves nothing of a set that is not sealed and counts it as pending', async () => {
    const w = world(); compose(w.ports);
    const { fs } = await supplySet(w, 2, { seal: false });
    const l = (await (await call('list', '')).json()) as { submissions: View[]; pendingCount: number };
    expect(l).toEqual({ submissions: [], pendingCount: 1 });
    expect((await call('view', SET)).status).toBe(409);
    expect((await call('download', SET, `?file=sub-${fs[0]!.operationId}`)).status).toBe(409);
  });
});
