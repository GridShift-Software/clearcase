// GRS-137 intake fix r1 (written findings M1, M2, M3 of the source review of 2a59f48e). New file: the 41 earlier tests are
// untouched. Unit doubles only (node:sqlite stands in for D1, MemoryOriginals for GRS-115); not real D1, R2 or workerd.
import { describe, expect, it } from 'vitest';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { readAtMost, readExactly } from '../../../src/lib/submissions/body.ts';
import { CASE_A, CLIENT, MemoryOriginals, SqliteD1, hex, identity, syntheticPdf, trackedBody, uploadAuthority } from './doubles.ts';
import { MIGRATIONS, compose, dispatch, repositoryFor } from './harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const BUDGET = { maxMetadataBytes: 2048, maxFileBytes: 4096 };
const AT = '2026-10-24T12:00:00.000Z';
const SHA_X = 'f'.repeat(64);

function world() {
  const db = new SqliteD1(MIGRATIONS), originals = new MemoryOriginals();
  compose({ clientId: CLIENT, budget: BUDGET, authorizeUpload: uploadAuthority([CASE_A]), originals, repository: repositoryFor(db), now: () => new Date(AT) });
  return { db, originals };
}
type W = ReturnType<typeof world>;

let seq = 0;
const op = () => `op-${String(++seq).padStart(4, '0')}-fix1c2f3e1d2a4c5b`;
type Init = { origin?: string | null; contentType?: string; body?: BodyInit | ReadableStream<Uint8Array>; who?: Identity };
function event(path: string, method: string, init: Init, params: Record<string, string>) {
  const url = new URL(path, ORIGIN), headers = new Headers();
  headers.set('origin', init.origin ?? ORIGIN);
  if (init.contentType) headers.set('content-type', init.contentType);
  const request = new Request(url, { method, headers, body: init.body as BodyInit, ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
  return { request, url, params, locals: { identity: init.who ?? identity() } };
}
const declare = (meta: unknown, init: Init = {}) =>
  dispatch('submissions', 'POST', event('/client/intake/case-a/submissions', 'POST', { contentType: 'application/json', body: JSON.stringify(meta), ...init }, { caseId: 'case-a' }));
// A thrown (uncaught) error is returned as a value, so a 500-class escape fails the assertion instead of the test run.
const settle = (p: Promise<Response>): Promise<Response | Error> => p.then((r) => r, (e) => (e instanceof Error ? e : new Error(String(e))));
const put = (operationId: string, body: Uint8Array | ReadableStream<Uint8Array>) =>
  settle(dispatch('submission', 'PUT', event(`/client/intake/case-a/submissions/${operationId}`, 'PUT', { contentType: 'application/pdf', body: body as BodyInit }, { caseId: 'case-a', operationId })));
const read = (operationId: string) => dispatch('submission', 'GET', event(`/client/intake/case-a/submissions/${operationId}`, 'GET', {}, { caseId: 'case-a', operationId }));
const meta = (bytes: Uint8Array, operationId: string) => ({ operationId, path: 'Letters/claim.pdf', size: bytes.byteLength, sha256: hex(bytes), mediaType: 'application/pdf' });
const status = (r: Response | Error) => (r instanceof Response ? r.status : `escaped: ${r.message}`);
const codeOf = async (r: Response | Error) => (r instanceof Response ? ((await r.clone().json()) as { code: string }).code : `escaped: ${r.message}`);
const puts = (w: W) => w.originals.calls.filter((c) => c === 'put').length;

/** A request body that delivers `after` bytes and then fails like a dropped connection (or, with `cancelFails`, also refuses to cancel). */
function brokenBody(bytes: Uint8Array, o: { after: number; chunk?: number; cancelFails?: boolean }) {
  const state = { pulled: 0, cancelled: false };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= o.after) { c.error(new Error('connection reset')); return; }
      const next = Math.min(o.after, at + (o.chunk ?? 16));
      state.pulled += next - at;
      c.enqueue(bytes.slice(at, next));
      at = next;
    },
    cancel() { state.cancelled = true; if (o.cancelFails) throw new Error('cancel failed'); },
  }, { highWaterMark: 0 });
  return { stream, state };
}

// Every original the store has bound to a case must have a durable, matching input record in the intake's own tables.
function boundWithoutRecord(w: W): string[] {
  const rows = w.db.rows<{ case_id: string; asset_id: string; sha256: string }>(
    'SELECT f.case_id, f.asset_id, f.sha256 FROM submissions_file f JOIN submissions_revision r ON r.client_id = f.client_id AND r.case_id = f.case_id AND r.revision_id = f.revision_id');
  return [...w.originals.bound].filter(([k, sha]) => !rows.some((r) => `${r.case_id}/${r.asset_id}` === k && r.sha256 === sha)).map(([k]) => k);
}

describe('M1: INSERT OR REPLACE cannot rewrite a recorded declaration, revision or file', () => {
  async function recorded(n = 1) {
    const w = world(), repo = repositoryFor(w.db), ops: string[] = [];
    for (let i = 0; i < n; i++) {
      const operationId = op(), bytes = syntheticPdf(`m1-${i}`);
      await repo.declare({ clientId: CLIENT, caseId: CASE_A, operationId, assetId: `sub-${operationId}`, path: 'a/claim.pdf', filename: 'claim.pdf', mediaType: 'application/pdf', size: bytes.byteLength, sha256: hex(bytes), principal: { issuer: 'https://issuer.test', subject: 'user-a' }, at: AT });
      const s = { clientId: CLIENT, caseId: CASE_A, operationId };
      await repo.markStored({ ...s, at: AT });
      await repo.commitRevision({ ...s, at: AT });
      ops.push(operationId);
    }
    return { w, ops };
  }
  const snapshot = (w: W) => ['submissions_upload', 'submissions_revision', 'submissions_file'].map((t) => w.db.rows(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4`));
  function refused(w: W, sql: string) {
    const before = snapshot(w);
    expect(() => w.db.exec(sql), sql).toThrow();
    expect(snapshot(w), `rows unchanged after: ${sql}`).toEqual(before);
  }

  it.each([
    ['a finalized file row: new path, size and sha256', `INSERT OR REPLACE INTO submissions_file (client_id, case_id, revision_id, path, path_key, filename, media_type, size, sha256, asset_id)
      SELECT client_id, case_id, revision_id, 'evil/other.pdf', 'evil/other.pdf', 'other.pdf', media_type, 1, '${SHA_X}', asset_id FROM submissions_file`],
    ['a finalized file row: identical values (still a delete and insert)', `INSERT OR REPLACE INTO submissions_file SELECT * FROM submissions_file`],
    ['a revision: another sequence', `INSERT OR REPLACE INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at)
      SELECT client_id, case_id, revision_id, 7, operation_id, file_count, finalized_at FROM submissions_revision`],
    ['a revision: rebound by its operation key to another revision id', `INSERT OR REPLACE INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at)
      SELECT client_id, case_id, 'subrev-rebound', 5, operation_id, file_count, finalized_at FROM submissions_revision`],
    ['a received/stored upload: another declaration and principal', `INSERT OR REPLACE INTO submissions_upload (client_id, case_id, operation_id, asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at)
      SELECT client_id, case_id, operation_id, asset_id, 'b/other.pdf', 'other.pdf', media_type, 9, '${SHA_X}', 'received', 'https://evil.test', 'someone-else', declared_at FROM submissions_upload`],
    ['an upload: rebound by its asset key to another operation id', `INSERT OR REPLACE INTO submissions_upload (client_id, case_id, operation_id, asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at)
      SELECT client_id, case_id, 'op-rebound-0000000000', asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at FROM submissions_upload`],
  ])('refuses REPLACE of %s', async (_name, sql) => {
    const { w } = await recorded();
    refused(w, sql);
  });

  it('refuses REPLACE of the second revision by the first one\'s sequence key', async () => {
    const { w } = await recorded(2);
    refused(w, `INSERT OR REPLACE INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at)
      SELECT client_id, case_id, revision_id, 1, operation_id, file_count, finalized_at FROM submissions_revision WHERE sequence = 2`);
  });

  it('refuses a plain INSERT of a second file into a finalized revision', async () => {
    const { w } = await recorded();
    refused(w, `INSERT INTO submissions_file (client_id, case_id, revision_id, path, path_key, filename, media_type, size, sha256, asset_id)
      SELECT client_id, case_id, revision_id, 'extra/second.pdf', 'extra/second.pdf', 'second.pdf', media_type, size, sha256, asset_id FROM submissions_file`);
  });

  it('still lets the repository declare, repeat and commit idempotently', async () => {
    const { w, ops } = await recorded();
    const repo = repositoryFor(w.db), s = { clientId: CLIENT, caseId: CASE_A, operationId: ops[0] };
    const bytes = syntheticPdf('m1-0');
    const d = { ...s, assetId: `sub-${ops[0]}`, path: 'a/claim.pdf', filename: 'claim.pdf', mediaType: 'application/pdf' as const, size: bytes.byteLength, sha256: hex(bytes), principal: { issuer: 'https://issuer.test', subject: 'user-a' }, at: AT };
    expect(await repo.declare(d)).toEqual({ kind: 'declared', repeated: true });
    expect((await repo.commitRevision({ ...s, at: AT })).sequence).toBe(1);
  });
});

describe('M2: an interrupted or erroring request body is a controlled 400, never an escape', () => {
  it('answers a file stream that errors mid-body with 400 incomplete-body and stores and acknowledges nothing', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    await declare(meta(bytes, operationId));
    const r = await put(operationId, brokenBody(bytes, { after: 30 }).stream);
    expect(status(r)).toBe(400);
    expect(await codeOf(r)).toBe('incomplete-body');
    expect(w.originals.calls).toEqual(['declare']);
    expect(w.originals.objects.size).toBe(0);
    expect(((await (await read(operationId)).json()) as { stage: string }).stage).toBe('received');
    expect(status(await put(operationId, bytes))).toBe(201);
  });

  it('answers a stream that errors before its first byte, and one that errors after every declared byte, the same way', async () => {
    const w = world(), bytes = syntheticPdf(), first = op(), last = op();
    await declare(meta(bytes, first));
    await declare(meta(bytes, last));
    expect(status(await put(first, brokenBody(bytes, { after: 0 }).stream))).toBe(400);
    expect(status(await put(last, brokenBody(bytes, { after: bytes.byteLength }).stream))).toBe(400);
    expect(w.originals.calls).toEqual(['declare', 'declare']);
  });

  it('answers a declaration body that errors with 400 incomplete-body and declares nothing', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    const json = new TextEncoder().encode(JSON.stringify(meta(bytes, operationId)));
    const r = await settle(declare({}, { body: brokenBody(json, { after: 20 }).stream }));
    expect(status(r)).toBe(400);
    expect(await codeOf(r)).toBe('incomplete-body');
    expect(w.originals.calls).toEqual([]);
    expect(w.db.rows('SELECT * FROM submissions_upload')).toEqual([]);
  });

  it('releases the reader and reports no stored bytes from the readers when the stream breaks', async () => {
    const bytes = syntheticPdf();
    const b = brokenBody(bytes, { after: 20 });
    expect(await readExactly(b.stream, bytes.byteLength)).toEqual({ kind: 'incomplete' });
    expect(b.stream.locked).toBe(false);
    expect(await readAtMost(brokenBody(bytes, { after: 20 }).stream, 1000)).toEqual({ kind: 'incomplete' });
  });

  it('answers 413 for an over-long body even when cancelling the stream fails', async () => {
    const w = world(), bytes = syntheticPdf(), operationId = op();
    await declare(meta(bytes, operationId));
    const longer = new Uint8Array(bytes.byteLength * 4); longer.set(bytes);
    const b = brokenBody(longer, { after: longer.byteLength, cancelFails: true, chunk: 64 });
    const r = await put(operationId, b.stream);
    expect(status(r)).toBe(413);
    expect(b.state.cancelled).toBe(true);
    expect(b.state.pulled).toBeLessThanOrEqual(bytes.byteLength + 64);
    expect(w.originals.calls).toEqual(['declare']);
  });
});

describe('M3: the manifest facts are durable before the original becomes visible, and a retry needs no new upload', () => {
  async function declared(w: W) {
    const bytes = syntheticPdf(), operationId = op();
    expect((await declare(meta(bytes, operationId))).status).toBe(201);
    return { bytes, operationId, w };
  }

  it('does not finalize the original while the manifest facts cannot be recorded', async () => {
    const w = world(), { bytes, operationId } = await declared(w);
    w.db.failNext = /INSERT INTO submissions_revision/;
    const r = await put(operationId, bytes);
    expect(status(r)).toBe(503);
    expect(await codeOf(r)).toBe('manifest-unrecorded');
    expect([...w.originals.bound]).toEqual([]);
    expect(w.originals.calls).not.toContain('finalize');
    expect(w.originals.objects.size).toBe(1);
  });

  it.each([
    ['the revision insert', () => { }, /INSERT INTO submissions_revision/, null],
    ['the revision file insert', () => { }, /INSERT INTO submissions_file/, null],
    ['the original store finalize', () => { }, null, 'finalize' as const],
    ['the acknowledgement that the revision is final', () => { }, /SET state = 'finalized'/, null],
  ])('recovers after a fault in %s without reading or putting the PDF again', async (_name, _x, sql, step) => {
    const w = world(), { bytes, operationId } = await declared(w);
    if (sql) w.db.failNext = sql;
    if (step) w.originals.failNext = step;
    const first = await put(operationId, bytes);
    expect(status(first)).toBe(503);
    // whatever the store made visible has a matching durable record, and the stage is pending, not finalized
    expect(boundWithoutRecord(w)).toEqual([]);
    const pending = (await (await read(operationId)).json()) as { stage: string; manifest: unknown; results: string; handoff: unknown[] };
    expect(pending).toMatchObject({ stage: 'stored-not-finalized', manifest: null, results: 'none', handoff: [] });
    expect(w.originals.objects.size).toBe(1);
    // the retry sends a body, but nothing may pull it: the stored bytes were verified already
    const t = trackedBody(bytes);
    const retry = await put(operationId, t.stream);
    expect(status(retry)).toBe(201);
    const body = (await (retry as Response).json()) as { stage: string; manifest: { sequence: number; revisionId: string } };
    expect(body.stage).toBe('finalized');
    expect(body.manifest.sequence).toBe(1);
    expect(t.state.pulled).toBe(0);
    expect(puts(w)).toBe(1);
    expect(boundWithoutRecord(w)).toEqual([]);
    expect(w.db.rows('SELECT * FROM submissions_revision')).toHaveLength(1);
    expect(w.db.rows('SELECT * FROM submissions_file')).toHaveLength(1);
  });

  it('never has a bound original without a durable record in a clean run, and a replay stays identical', async () => {
    const w = world(), { bytes, operationId } = await declared(w);
    const first = await put(operationId, bytes);
    expect(status(first)).toBe(201);
    expect(w.originals.bound.size).toBe(1);
    expect(boundWithoutRecord(w)).toEqual([]);
    const replay = await put(operationId, bytes);
    expect(status(replay)).toBe(200);
    expect(((await (replay as Response).json()) as { manifest: unknown }).manifest).toEqual(((await (first as Response).json()) as { manifest: unknown }).manifest);
  });
});
