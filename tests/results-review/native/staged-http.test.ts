// The chunked import over HTTP: the real route modules and controller, the ports installed through the composition point.
// Authority comes before any body byte, the base64 is strict, and every refusal keeps the import where it was.
import { describe, expect, it } from 'vitest';
import * as open from '../../../deploy/client/routes/operator/results/[caseId]/imports/staged/+server.ts';
import * as status from '../../../deploy/client/routes/operator/results/[caseId]/imports/staged/[operationId]/+server.ts';
import * as files from '../../../deploy/client/routes/operator/results/[caseId]/imports/staged/[operationId]/files/+server.ts';
import * as complete from '../../../deploy/client/routes/operator/results/[caseId]/imports/staged/[operationId]/complete/+server.ts';
import { decodeBase64Strict, encodeBase64 } from '../../../src/lib/results-review/native/staging/base64.ts';
import { ValidatingStager, trackedBody, who } from './doubles.ts';
import { buildFixture, pdf } from './fixtures.ts';
import { compose } from './harness.ts';
import { Durable, sha256Hex, stagedPorts, submissionOf } from './staged-world.ts';

const OP = 'op-http-0001-0b7c2f3e1d2a4c5b';
const REVISION = 'subrev-http';
const base = 'https://client-a.clearcase.test';
const modules = { open, status, files, complete } as unknown as Record<string, Record<string, (e: never) => Promise<Response>>>;

async function call(route: keyof typeof modules, method: 'GET' | 'POST', path: string, params: Record<string, string>, o: { body?: unknown; raw?: BodyInit; origin?: string | null; type?: string } = {}) {
  const url = new URL(path, base);
  const headers = new Headers(method === 'POST' ? { 'content-type': o.type ?? 'application/json', ...(o.origin === null ? {} : { origin: o.origin ?? url.origin }) } : {});
  const request = new Request(url, { method, headers, body: method === 'GET' ? undefined : (o.raw ?? JSON.stringify(o.body ?? {})), ...(o.raw && typeof o.raw !== 'string' ? { duplex: 'half' } : {}) } as RequestInit);
  const res = await modules[route]![method]!({ request, url, params, locals: { identity: who() }, platform: undefined } as never);
  return { status: res.status, json: await res.json() as Record<string, any> };
}
const doc = { ref: 'OD-001', path: 'Letters/A.pdf', bytes: pdf('a') };
async function world(o: { operate?: boolean; staging?: boolean } = {}) {
  const fx = buildFixture({ docs: [doc] });
  const stager = new ValidatingStager();
  stager.folder = new Map([[doc.path, doc.bytes]]);
  const durable = new Durable();
  const submissions = await submissionOf('case-a', [{ path: doc.path, sha256: sha256Hex(doc.bytes), size: doc.bytes.byteLength }], REVISION);
  const ports = stagedPorts({ durable, caseId: 'case-a', stager: stager as never, submissions, ...o });
  compose(ports as never);
  return { fx, durable, stager };
}
const root = '/operator/results/case-a/imports/staged';
const step = (suffix = '') => `${root}/${OP}${suffix}`;
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const listed = (files: ReadonlyMap<string, Uint8Array>) => [...files.keys()].filter((p) => p !== 'manifest.json');

describe('the chunked import over HTTP', () => {
  it('opens, takes a batch, reports status, completes and answers a repeat', async () => {
    const { fx } = await world();
    const opened = await call('open', 'POST', root, { caseId: 'case-a' }, { body: { operationId: OP, submissionRevisionId: REVISION, manifest: text(fx.files.get('manifest.json')!) } });
    expect(opened.status).toBe(201);
    expect(opened.json).toMatchObject({ kind: 'progress', state: 'open', expectedFiles: listed(fx.files).length, acceptedFiles: 0 });
    expect(opened.json.missing).toEqual(listed(fx.files).sort());

    const batch = Object.fromEntries(listed(fx.files).map((p) => [p, encodeBase64(fx.files.get(p)!)]));
    const put = await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { body: { files: batch } });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ acceptedFiles: listed(fx.files).length, missing: [], batch: { written: listed(fx.files).length, alreadyAccepted: 0 } });
    const again = await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { body: { files: batch } });
    expect(again.json.batch).toEqual({ written: 0, alreadyAccepted: listed(fx.files).length });

    const got = await call('status', 'GET', step(), { caseId: 'case-a', operationId: OP });
    expect(got).toMatchObject({ status: 200, json: { state: 'open', missingFiles: 0 } });
    const done = await call('complete', 'POST', step('/complete'), { caseId: 'case-a', operationId: OP });
    expect(done.status).toBe(201);
    expect(done.json).toMatchObject({ kind: 'linked', repeated: false });
    const repeat = await call('complete', 'POST', step('/complete'), { caseId: 'case-a', operationId: OP });
    expect(repeat).toMatchObject({ status: 200, json: { kind: 'linked', repeated: true } });
    expect(repeat.json.candidate.candidateId).toBe(done.json.candidate.candidateId);
    expect((await call('status', 'GET', step(), { caseId: 'case-a', operationId: OP })).json).toMatchObject({ state: 'complete', candidateId: done.json.candidate.candidateId });
  });

  it('refuses before reading a body byte when the operator lacks the case, and a cross-origin or mistyped write', async () => {
    const { fx, durable } = await world({ operate: false });
    const tracked = trackedBody(new TextEncoder().encode(JSON.stringify({ files: {} })));
    const denied = await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { raw: tracked.stream });
    expect(denied.status).toBe(403);
    expect(tracked.state.pulled).toBe(0);
    expect((await call('open', 'POST', root, { caseId: 'case-a' }, { body: { operationId: OP, submissionRevisionId: REVISION, manifest: text(fx.files.get('manifest.json')!) } })).status).toBe(403);
    expect((await call('status', 'GET', step(), { caseId: 'case-a', operationId: OP })).status).toBe(404);
    expect(durable.db.rows('SELECT 1 FROM native_import_session')).toHaveLength(0);
    await world();
    expect((await call('open', 'POST', root, { caseId: 'case-a' }, { origin: 'https://elsewhere.test', body: {} })).status).toBe(403);
    expect((await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { type: 'text/plain', body: {} })).status).toBe(415);
  });

  it('refuses malformed base64, unlisted and mismatched files, and an unknown or missing session, leaving the import where it was', async () => {
    const { fx, durable } = await world();
    const manifest = text(fx.files.get('manifest.json')!);
    expect((await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { body: { files: {} } })).status).toBe(413);
    expect((await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { body: { files: { 'assets.json': 'AAAA' } } })).json.code).toBe('session-not-found');
    await call('open', 'POST', root, { caseId: 'case-a' }, { body: { operationId: OP, submissionRevisionId: REVISION, manifest } });
    const path = listed(fx.files).sort()[0]!;
    const good = encodeBase64(fx.files.get(path)!);
    for (const bad of [` ${good}`, good.replace(/\+/g, '-').replace(/\//g, '_') + 'x', good.slice(0, -1), good.replace(/=+$/, ''), 5 as unknown as string]) {
      const out = await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { body: { files: { [path]: bad } } });
      expect(out.status).toBe(422);
      expect(out.json.code).toBe('invalid-request');
    }
    const flipped = new Uint8Array(fx.files.get(path)!);
    flipped[flipped.length - 1] ^= 1;
    const mismatch = await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { body: { files: { [path]: encodeBase64(flipped) } } });
    expect(mismatch).toMatchObject({ status: 422, json: { code: 'file-mismatch' } });
    const unlisted = await call('files', 'POST', step('/files'), { caseId: 'case-a', operationId: OP }, { body: { files: { 'datasets/other.json': encodeBase64(new Uint8Array([1])) } } });
    expect(unlisted).toMatchObject({ status: 422, json: { code: 'file-not-in-manifest' } });
    const held = await call('complete', 'POST', step('/complete'), { caseId: 'case-a', operationId: OP });
    expect(held).toMatchObject({ status: 409, json: { code: 'incomplete' } });
    expect(durable.db.rows('SELECT 1 FROM native_import_staged_file')).toHaveLength(0);
    expect(durable.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(0);
  });

  it('answers 503 when the chunked import is not composed, and reuses an operation id only for the same request', async () => {
    const { fx } = await world({ staging: false });
    const manifest = text(fx.files.get('manifest.json')!);
    expect((await call('open', 'POST', root, { caseId: 'case-a' }, { body: { operationId: OP, submissionRevisionId: REVISION, manifest } })).status).toBe(503);
    await world();
    expect((await call('open', 'POST', root, { caseId: 'case-a' }, { body: { operationId: OP, submissionRevisionId: REVISION, manifest } })).status).toBe(201);
    expect((await call('open', 'POST', root, { caseId: 'case-a' }, { body: { operationId: OP, submissionRevisionId: REVISION, manifest } })).json).toMatchObject({ repeated: true });
    const other = await call('open', 'POST', root, { caseId: 'case-a' }, { body: { operationId: OP, submissionRevisionId: 'subrev-other', manifest } });
    expect(other).toMatchObject({ status: 409, json: { code: 'operation-reused' } });
  });
});

describe('strict base64', () => {
  it('round-trips every length and refuses anything that is not canonical padded standard base64', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(Array.from(decodeBase64Strict(encodeBase64(bytes))!)).toEqual(Array.from(bytes));
    }
    for (const bad of ['A', 'AA', 'AAA', 'AAAA\n', ' AAAA', 'AA=A', '=AAA', 'AB==', 'AAC=', 'AA-_', 'AAAA=AAA', 'ÄAAA']) expect(decodeBase64Strict(bad)).toBeNull();
  });
});
