// U16 multi-file intake: one submission revision holding an immutable set of files with an exact manifest. Synthetic PDFs only;
// the storage and identity sides are unit doubles (doubles.ts), so a pass here is component evidence, not a hosted PASS.
import { describe, expect, it } from 'vitest';
import { fileSetDigest, MAX_SET_FILES } from '../../../src/lib/submissions/file-set.ts';
import { CASE_A, CLIENT, MemoryOriginals, SqliteD1, hex, identity, syntheticPdf, uploadAuthority } from './doubles.ts';
import { MIGRATIONS, compose, dispatch, repositoryFor } from './harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const BUDGET = { maxMetadataBytes: 2048, maxFileBytes: 4096 };
const STEP = { files: 2, bytes: 1 << 30, ms: 60_000 };

function world(db = new SqliteD1(MIGRATIONS), originals = new MemoryOriginals()) {
  const ports = {
    clientId: CLIENT, budget: BUDGET, authorizeUpload: uploadAuthority([CASE_A]), originals, repository: repositoryFor(db),
    now: () => new Date('2026-10-27T09:00:00.000Z'), sealStep: STEP, setPage: 3,
  };
  compose(ports);
  return { db, originals, ports, restart: () => world(db, originals) };
}

function event(path: string, method: string, params: Record<string, string>, init: { contentType?: string; body?: BodyInit } = {}) {
  const url = new URL(path, ORIGIN), headers = new Headers({ origin: ORIGIN });
  if (init.contentType) headers.set('content-type', init.contentType);
  return { request: new Request(url, { method, headers, body: init.body }), url, params, locals: { identity: identity() } };
}
const json = (v: unknown) => ({ contentType: 'application/json', body: JSON.stringify(v) });
const base = (caseId: string) => `/client/intake/${caseId}`;
const openSet = (setId: string, fileCount: number, totalBytes: number, caseId = 'case-a') =>
  dispatch('sets', 'POST', event(`${base(caseId)}/sets`, 'POST', { caseId }, json({ setId, fileCount, totalBytes })));
const declareFile = (setId: string, meta: unknown, caseId = 'case-a') =>
  dispatch('set-files', 'POST', event(`${base(caseId)}/sets/${setId}/files`, 'POST', { caseId, setId }, json(meta)));
const putFile = (setId: string, operationId: string, bytes: Uint8Array, caseId = 'case-a') =>
  dispatch('set-file', 'PUT', event(`${base(caseId)}/sets/${setId}/files/${operationId}`, 'PUT', { caseId, setId, operationId }, { contentType: 'application/pdf', body: bytes as BodyInit }));
const seal = (setId: string, filesSha256: string, caseId = 'case-a') =>
  dispatch('set-seal', 'POST', event(`${base(caseId)}/sets/${setId}/seal`, 'POST', { caseId, setId }, json({ filesSha256 })));
const readSet = (setId: string, after?: string, caseId = 'case-a') =>
  dispatch('set', 'GET', event(`${base(caseId)}/sets/${setId}${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`, 'GET', { caseId, setId }));
const list = (caseId = 'case-a') => dispatch('submissions', 'GET', event(`${base(caseId)}/submissions`, 'GET', { caseId }));
const declareOne = (meta: unknown) => dispatch('submissions', 'POST', event(`${base('case-a')}/submissions`, 'POST', { caseId: 'case-a' }, json(meta)));
const putOne = (operationId: string, bytes: Uint8Array) =>
  dispatch('submission', 'PUT', event(`${base('case-a')}/submissions/${operationId}`, 'PUT', { caseId: 'case-a', operationId }, { contentType: 'application/pdf', body: bytes as BodyInit }));
const body = async <T = Record<string, unknown>>(r: Response) => (await r.clone().json()) as T;

type SetView = { setId: string; state: string; fileCount: number; totalBytes: number; declared: number; stored: number; finalized: number; filesSha256: string | null; revision: { revisionId: string; sequence: number } | null };
const SET = 'set-0001-0b7c2f3e1d2a4c5b';
const files = (n: number, tag = 'f') => Array.from({ length: n }, (_, i) => {
  const bytes = syntheticPdf(`${tag}-${i}`);
  return { operationId: `${tag}${String(i).padStart(4, '0')}-0b7c2f3e1d2a4c5b`, path: `Bundle ${i % 2 ? 'B' : 'A'}/letter ${i}.pdf`, bytes };
});
type F = ReturnType<typeof files>[number];
const metaOf = (f: F) => ({ operationId: f.operationId, path: f.path, size: f.bytes.byteLength, sha256: hex(f.bytes), mediaType: 'application/pdf' });
const total = (fs: readonly F[]) => fs.reduce((n, f) => n + f.bytes.byteLength, 0);
const digestOf = (fs: readonly F[]) => fileSetDigest(fs.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: hex(f.bytes) })));
const rows = (db: SqliteD1) => Object.fromEntries(['submissions_upload', 'submissions_revision', 'submissions_file', 'submissions_set', 'submissions_set_member']
  .map((t) => [t, db.rows(`SELECT * FROM ${t} ORDER BY 1, 2, 3`)]));

async function sealUntilDone(setId: string, digest: string) {
  const statuses: number[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await seal(setId, digest);
    statuses.push(r.status);
    if (r.status !== 202) return { r, statuses, set: (await body<{ set: SetView }>(r)).set };
  }
  throw new Error('seal did not finish');
}
async function supplyAll(fs: readonly F[], setId = SET) {
  expect((await openSet(setId, fs.length, total(fs))).status).toBe(201);
  for (const f of fs) expect((await declareFile(setId, metaOf(f))).status).toBe(201);
  for (const f of fs) expect((await putFile(setId, f.operationId, f.bytes)).status).toBe(201);
}

describe('a multi-file submission revision', () => {
  it('declares and stores each file on its own, then seals them into one revision with an exact manifest', async () => {
    const w = world(), fs = files(5);
    await supplyAll(fs);
    const before = await body<{ set: SetView }>(await readSet(SET));
    expect(before.set).toMatchObject({ state: 'open', fileCount: 5, declared: 5, stored: 5, finalized: 0, filesSha256: null, revision: null });
    // No original is visible before the seal: GRS-115 holds each file stored, none finalized.
    expect([...w.originals.uploads.values()].map((u) => u.state)).toEqual(Array(5).fill('stored'));

    const done = await sealUntilDone(SET, await digestOf(fs));
    expect(done.statuses).toEqual([202, 202, 201]);
    expect(done.set).toMatchObject({ state: 'sealed', fileCount: 5, finalized: 5, filesSha256: await digestOf(fs), revision: { revisionId: `subrev-${SET}`, sequence: 1 } });
    expect([...w.originals.uploads.values()].map((u) => u.state)).toEqual(Array(5).fill('finalized'));

    const m = await w.ports.repository.revision({ clientId: CLIENT, caseId: CASE_A, operationId: SET });
    expect(m).toMatchObject({ revisionId: `subrev-${SET}`, sequence: 1, operationId: SET });
    expect(m!.files.map((f) => f.path)).toEqual([...fs.map((f) => f.path)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
    expect(new Set(m!.files.map((f) => `${f.path}|${f.size}|${f.sha256}|${f.assetId}`))).toEqual(new Set(fs.map((f) => `${f.path}|${f.bytes.byteLength}|${hex(f.bytes)}|sub-${f.operationId}`)));
    expect(w.db.rows('SELECT file_count FROM submissions_revision')).toEqual([{ file_count: 5 }]);

    // The case's list shows one sealed set, not five submissions; a repeat seal answers the same sealed set.
    const l = await body<{ submissions: unknown[]; sets: SetView[] }>(await list());
    expect(l.submissions).toEqual([]);
    expect(l.sets).toEqual([done.set]);
    const again = await seal(SET, await digestOf(fs));
    expect(again.status).toBe(200);
    expect((await body<{ set: SetView }>(again)).set).toEqual(done.set);
  });

  it('resumes after a kill at every stage and ends exactly where an uninterrupted intake ends', async () => {
    const fs = files(5);
    const reference = world();
    await supplyAll(fs);
    await sealUntilDone(SET, await digestOf(fs));
    const expected = rows(reference.db);

    let w = world();
    expect((await openSet(SET, fs.length, total(fs))).status).toBe(201);
    for (const f of fs.slice(0, 3)) expect((await declareFile(SET, metaOf(f))).status).toBe(201);
    // killed mid-way through storing: the third file's store fails, then the process is gone
    expect((await putFile(SET, fs[0]!.operationId, fs[0]!.bytes)).status).toBe(201);
    w.originals.failNext = 'put';
    expect((await putFile(SET, fs[1]!.operationId, fs[1]!.bytes)).status).toBe(503);
    w = w.restart();
    // The page asks the set what is left: every declared file with its stage, in path order.
    const left = await body<{ files: { operationId: string; stage: string }[] }>(await readSet(SET));
    expect(Object.fromEntries(left.files.map((f) => [f.operationId, f.stage]))).toEqual({ [fs[0]!.operationId]: 'stored', [fs[1]!.operationId]: 'received', [fs[2]!.operationId]: 'received' });
    // A seal before the set is complete is refused and records nothing.
    const early = await seal(SET, await digestOf(fs));
    expect(early.status).toBe(409);
    expect(await body(early)).toMatchObject({ code: 'set-incomplete', fileCount: 5, declared: 3, stored: 1 });
    for (const f of fs.slice(3)) expect((await declareFile(SET, metaOf(f))).status).toBe(201);
    for (const f of fs.slice(1)) expect((await putFile(SET, f.operationId, f.bytes)).status).toBe(201);
    expect((await putFile(SET, fs[0]!.operationId, fs[0]!.bytes)).status).toBe(200);

    // killed during the seal: once in an original's finalize, once after a finalize before the member was marked
    expect((await seal(SET, await digestOf(fs))).status).toBe(202);
    w.originals.failNext = 'finalize';
    expect((await seal(SET, await digestOf(fs))).status).toBe(503);
    w = w.restart();
    w.db.failNext = /SET state = 'finalized'/;
    expect((await seal(SET, await digestOf(fs))).status).toBe(503);
    w = w.restart();
    const done = await sealUntilDone(SET, await digestOf(fs));
    expect(done.set.state).toBe('sealed');
    expect(rows(w.db)).toEqual(expected);
  });

  it('pages the set\'s files in path order so a resume never reads the whole set at once', async () => {
    world();
    const fs = files(7);
    await supplyAll(fs);
    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await body<{ files: { path: string }[]; next: string | null }>(await readSet(SET, after));
      seen.push(...page.files.map((f) => f.path));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(fs.map((f) => f.path)));
  });
});

describe('a sealed set is immutable; a new set is a new revision', () => {
  it('refuses any change to a sealed set, through the routes and in SQL', async () => {
    const w = world(), fs = files(3);
    await supplyAll(fs);
    await sealUntilDone(SET, await digestOf(fs));
    const sealed = rows(w.db);
    const extra = files(1, 'x')[0]!;
    const late = await declareFile(SET, metaOf(extra));
    expect(late.status).toBe(409);
    expect((await body(late)).code).toBe('set-closed');
    const other = await seal(SET, await digestOf(fs.slice(0, 2)));
    expect(other.status).toBe(409);
    expect((await body(other)).code).toBe('manifest-mismatch');
    expect((await openSet(SET, 4, total(fs))).status).toBe(409);
    for (const sql of [
      "UPDATE submissions_set SET state = 'open'", "UPDATE submissions_set SET files_sha256 = '" + '0'.repeat(64) + "'", 'UPDATE submissions_set SET file_count = 4', 'DELETE FROM submissions_set',
      "UPDATE submissions_set_member SET path_key = 'x'", 'DELETE FROM submissions_set_member', 'UPDATE submissions_revision SET file_count = 4', 'DELETE FROM submissions_revision',
      "UPDATE submissions_file SET sha256 = '" + '0'.repeat(64) + "'", 'DELETE FROM submissions_file', "UPDATE submissions_upload SET state = 'stored'",
    ]) expect(() => w.db.exec(sql), sql).toThrow();
    expect(() => w.db.exec(`INSERT OR REPLACE INTO submissions_set_member (client_id, case_id, set_id, operation_id, path_key) SELECT client_id, case_id, set_id, '${extra.operationId}', path_key FROM submissions_set_member LIMIT 1`)).toThrow();
    expect(() => w.db.exec(`INSERT OR REPLACE INTO submissions_file SELECT * FROM submissions_file LIMIT 1`)).toThrow();
    expect(rows(w.db)).toEqual(sealed);

    // The same files again, as a new set, are a new revision with the next sequence; the first one is unchanged.
    const SECOND = 'set-0002-0b7c2f3e1d2a4c5b';
    const again = files(3, 'g');
    await supplyAll(again, SECOND);
    const done = await sealUntilDone(SECOND, await digestOf(again));
    expect(done.set.revision).toEqual({ revisionId: `subrev-${SECOND}`, sequence: 2 });
    expect(rows(w.db).submissions_revision).toHaveLength(2);
  });

  it('fixes the digest at the seal: a different file list is refused before anything is recorded', async () => {
    const w = world(), fs = files(3);
    await supplyAll(fs);
    const before = rows(w.db);
    const wrong = await seal(SET, await digestOf([...fs.slice(0, 2), { ...fs[2]!, path: 'Bundle A/renamed.pdf' }]));
    expect(wrong.status).toBe(409);
    expect((await body(wrong)).code).toBe('manifest-mismatch');
    expect(rows(w.db)).toEqual(before);
    expect(w.originals.calls.filter((c) => c === 'finalize')).toEqual([]);
  });
});

describe('the cap is refused before anything is written', () => {
  it(`refuses more than ${MAX_SET_FILES} files, or more bytes than the files may hold, with no row and no store call`, async () => {
    const w = world(), empty = rows(w.db);
    const many = await openSet(SET, MAX_SET_FILES + 1, MAX_SET_FILES + 1);
    expect(many.status).toBe(413);
    expect((await body(many)).code).toBe('too-many-files');
    const heavy = await openSet(SET, 2, 2 * BUDGET.maxFileBytes + 1);
    expect(heavy.status).toBe(413);
    expect((await body(heavy)).code).toBe('too-large');
    expect(rows(w.db)).toEqual(empty);
    expect(w.originals.calls).toEqual([]);
    expect((await openSet(SET, MAX_SET_FILES, MAX_SET_FILES)).status).toBe(201);
  });

  it('refuses a file beyond the declared count, and a second file at a path the set already holds, before any write', async () => {
    const w = world(), fs = files(3);
    expect((await openSet(SET, 2, total(fs))).status).toBe(201);
    for (const f of fs.slice(0, 2)) expect((await declareFile(SET, metaOf(f))).status).toBe(201);
    const before = rows(w.db), calls = w.originals.calls.length;
    const full = await declareFile(SET, metaOf(fs[2]!));
    expect(full.status).toBe(409);
    expect((await body(full)).code).toBe('set-full');
    expect(rows(w.db)).toEqual(before);
    expect(w.originals.calls).toHaveLength(calls);

    const SECOND = 'set-0002-0b7c2f3e1d2a4c5b';
    expect((await openSet(SECOND, 2, total(fs))).status).toBe(201);
    expect((await declareFile(SECOND, metaOf(fs[2]!))).status).toBe(201);
    const taken = await declareFile(SECOND, { ...metaOf(files(1, 'y')[0]!), path: fs[2]!.path.toUpperCase() });
    expect(taken.status).toBe(409);
    expect((await body(taken)).code).toBe('path-taken');
  });
});

describe('single-file submissions keep working beside file sets', () => {
  it('finalizes a one-file submission as before, and keeps set files and single uploads apart', async () => {
    const w = world(), bytes = syntheticPdf('single'), operationId = 'one0-0000-0b7c2f3e1d2a4c5b';
    expect((await declareOne({ operationId, path: 'Letters/claim.pdf', size: bytes.byteLength, sha256: hex(bytes), mediaType: 'application/pdf' })).status).toBe(201);
    const done = await putOne(operationId, bytes);
    expect(done.status).toBe(201);
    expect((await body<{ stage: string; manifest: { sequence: number; files: unknown[] } }>(done))).toMatchObject({ stage: 'finalized', manifest: { sequence: 1, files: [{ path: 'Letters/claim.pdf' }] } });
    // A set id cannot reuse an upload's id, and a set file cannot be finalized on its own through the single-file route.
    expect((await body(await openSet(operationId, 1, bytes.byteLength))).code).toBe('operation-reused');
    const fs = files(2);
    await supplyAll(fs);
    const alone = await putOne(fs[0]!.operationId, fs[0]!.bytes);
    expect(alone.status).toBe(409);
    expect((await body(alone)).code).toBe('set-member');
    await sealUntilDone(SET, await digestOf(fs));
    const l = await body<{ submissions: { operationId: string; stage: string }[]; sets: SetView[] }>(await list());
    expect(l.submissions.map((s) => [s.operationId, s.stage])).toEqual([[operationId, 'finalized']]);
    expect(l.sets.map((s) => [s.setId, s.state, s.revision?.sequence])).toEqual([[SET, 'sealed', 2]]);
  });
});
