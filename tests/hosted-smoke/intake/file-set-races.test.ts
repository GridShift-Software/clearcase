// U16 fix 1: the review's seal probe, kept as a regression test. 0007 over a filesystem copy of the assembled old schema with a
// finalized single-file row; a delayed duplicate PUT across concurrent seals; a failed final mark then a fresh controller; late
// additions and a wrong digest after the seal; wrong-case and wrong-client calls. Synthetic SQLite and R2 doubles only.
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import * as migrations from '../../../deploy/native-alpha/runtime-migration.ts';
import { createIntakeController } from '../../../src/lib/submissions/controller.ts';
import { d1SubmissionRepository } from '../../../src/lib/submissions/repository.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';
import { submissionSnapshotReader } from '../../../src/lib/results-review/native/submission-reader.ts';
import { BUDGETS, QUOTAS, deployment, ids, pdf, shaOf } from '../../hosted-foundation/storage/fixture.ts';
import { identity, uploadAuthority } from './doubles.ts';

const inputs = (ps: readonly { path: string }[]) => ps.map((p) => ({ path: p.path, bytes: readFileSync(p.path) }));
const migrate = (db: DatabaseSync, sql: string) => { db.exec('BEGIN'); try { db.exec(sql); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
const AT = '2026-10-25T12:00:00.000Z', now = () => new Date(AT);

it('applies 0007 to a copy of the old schema with a finalized single-file row and leaves the source untouched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'u16-old-copy-'));
  try {
    const oldPath = path.join(dir, 'old.sqlite'), copyPath = path.join(dir, 'copy.sqlite');
    const old = new DatabaseSync(oldPath); old.exec('PRAGMA foreign_keys = ON');
    old.exec(assembleNativeSchema(inputs(NATIVE_SCHEMA_INPUTS)).sql);
    old.exec(migrations.assembleNativeRuntimeMigration(inputs(migrations.NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
    migrate(old, migrations.assembleNativeRenderCaseLimitMigration(inputs(migrations.NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
    migrate(old, migrations.assembleNativeEvidenceMigration(inputs(migrations.NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql);
    migrate(old, migrations.assembleNativeImportStagingMigration(inputs(migrations.NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).sql);
    old.exec(`INSERT INTO submissions_upload VALUES ('client-a', 'case-a', 'old-0000000000001', 'sub-old', 'old.pdf', 'old.pdf', 'application/pdf', 10, '${'a'.repeat(64)}', 'received', 'issuer', 'subject', '${AT}', NULL);
      UPDATE submissions_upload SET state = 'stored';
      INSERT INTO submissions_revision VALUES ('client-a', 'case-a', 'subrev-old-0000000000001', 1, 'old-0000000000001', 1, '${AT}');
      INSERT INTO submissions_file VALUES ('client-a', 'case-a', 'subrev-old-0000000000001', 'old.pdf', 'old.pdf', 'old.pdf', 'application/pdf', 10, '${'a'.repeat(64)}', 'sub-old');
      UPDATE submissions_upload SET state = 'finalized';`);
    const before = old.prepare('SELECT * FROM submissions_revision').all(); old.close(); copyFileSync(oldPath, copyPath);
    const copy = new DatabaseSync(copyPath); copy.exec('PRAGMA foreign_keys = ON');
    migrate(copy, migrations.assembleNativeIntakeFileSetsMigration(inputs(migrations.NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS)).sql);
    expect(copy.prepare('SELECT * FROM submissions_revision').all()).toEqual(before);
    expect(copy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'pub_provenance_submissions_revision_insert'").all()).toHaveLength(1);
    expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }); copy.close();
    const untouched = new DatabaseSync(oldPath);
    expect(untouched.prepare("SELECT name FROM sqlite_master WHERE name = 'submissions_set'").all()).toEqual([]); untouched.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('keeps one sealed set through a delayed duplicate PUT, concurrent seals, a failed mark, a restart and foreign callers', async () => {
  const w = deployment('client-a', ['case-a', 'case-b']), repo = d1SubmissionRepository(w.db);
  const originals = createOriginalIntake({ bindings: w, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now } as never);
  let held = false, release!: () => void, reached!: () => void;
  const barrier = new Promise<void>((r) => { release = r; }), entered = new Promise<void>((r) => { reached = r; });
  const ports = { clientId: ids.clientA, budget: { maxMetadataBytes: 4096, maxFileBytes: 1 << 20 }, authorizeUpload: uploadAuthority([ids.caseA]), repository: repo, now,
    originals: { ...originals, put: async (a: Parameters<typeof originals.put>[0]) => { const out = await originals.put(a); if (!held) { held = true; reached(); await barrier; } return out; } } };
  let c = createIntakeController(ports);
  const setId = 'set-probe-000000001', fs = ['a.pdf', 'b.pdf'].map((p, i) => ({ path: p, bytes: pdf(p), operationId: `file-probe-00000000${i}` }));
  const call = (method: 'openSet' | 'declareSetFile' | 'uploadSetFile' | 'sealSet' | 'readSet', body: unknown, op?: string, caseId = 'case-a', who = identity()) => {
    const raw = body instanceof Uint8Array, url = new URL(`https://client-a.test/client/intake/${caseId}/sets/${setId}`);
    const init: RequestInit = { method: method === 'readSet' ? 'GET' : raw ? 'PUT' : 'POST', headers: { origin: url.origin, 'content-type': raw ? 'application/pdf' : 'application/json' },
      ...(method === 'readSet' ? {} : { body: raw ? (body as BodyInit) : JSON.stringify(body) }) };
    return c[method]({ request: new Request(url, init), url, params: { caseId, setId, operationId: op }, identity: who });
  };
  expect((await call('openSet', { setId, fileCount: 2, totalBytes: fs.reduce((n, f) => n + f.bytes.length, 0) })).status).toBe(201);
  for (const f of fs) expect((await call('declareSetFile', { operationId: f.operationId, path: f.path, size: f.bytes.length, sha256: shaOf(f.bytes), mediaType: 'application/pdf' })).status).toBe(201);
  const delayed = call('uploadSetFile', fs[0]!.bytes, fs[0]!.operationId); await entered;
  expect((await call('uploadSetFile', fs[0]!.bytes, fs[0]!.operationId)).status).toBe(201);
  expect((await call('uploadSetFile', fs[1]!.bytes, fs[1]!.operationId)).status).toBe(201);
  const digest = await fileSetDigest(fs.map((f) => ({ path: f.path, size: f.bytes.length, sha256: shaOf(f.bytes) })));
  w.db.failNext = /UPDATE submissions_upload SET state = 'finalized'/;
  expect((await call('sealSet', { filesSha256: digest })).status).toBe(503);
  c = createIntakeController(ports);
  const seals = await Promise.all([call('sealSet', { filesSha256: digest }), call('sealSet', { filesSha256: digest })]);
  expect(seals.every((r) => [200, 201].includes(r.status))).toBe(true);
  const revisionId = `subrev-${setId}`, snap = await submissionSnapshotReader(w.db).finalized({ clientId: ids.clientA, caseId: ids.caseA, revisionId });
  expect(snap.state).toBe('finalized');
  const fixed = JSON.stringify(w.db.rows('SELECT * FROM submissions_file'));
  release(); expect((await delayed).status).toBe(201);
  expect((await call('declareSetFile', { operationId: 'file-extra-00000001', path: 'extra.pdf', size: 1, sha256: 'c'.repeat(64), mediaType: 'application/pdf' })).status).toBe(409);
  expect((await call('sealSet', { filesSha256: 'd'.repeat(64) })).status).toBe(409);
  for (const method of ['readSet', 'sealSet', 'uploadSetFile'] as const) {
    const body = method === 'uploadSetFile' ? fs[0]!.bytes : { filesSha256: digest };
    expect((await call(method, body, fs[0]!.operationId, 'case-b')).status).toBe(method === 'readSet' ? 404 : 403);
    expect((await call(method, body, fs[0]!.operationId, 'case-a', identity({ clientId: ids.clientB }))).status).toBe(401);
  }
  expect(JSON.stringify(w.db.rows('SELECT * FROM submissions_file'))).toBe(fixed);
  expect(await submissionSnapshotReader(w.db).finalized({ clientId: ids.clientA, caseId: ids.caseA, revisionId })).toEqual(snap);
  w.db.sqlite.close();
});
