import { expect, it, vi } from 'vitest';
import { createIntakeController } from '../../../src/lib/submissions/controller.ts';
import { createOperatorDownloadController } from '../../../src/lib/submissions/download/controller.ts';
import { intakeNotifications } from '../../../src/lib/submissions/notifications.ts';
import { d1SubmissionRepository } from '../../../src/lib/submissions/repository.ts';
import { CLIENT, CASE_A, MemoryOriginals, SqliteD1, hex, identity, syntheticPdf, uploadAuthority } from './doubles.ts';
import { MemoryAssets, MemoryAudit, identity as operatorIdentity, operateAuthority } from '../operator-download/doubles.ts';
import { MIGRATIONS } from './harness.ts';
import { at, migration, scope } from './19-fixture.ts';

function singleWorld(send: typeof fetch) {
  const db = new SqliteD1([...MIGRATIONS, migration]), repository = d1SubmissionRepository(db);
  const background: Promise<void>[] = [];
  const notifications = intakeNotifications({ clientId: CLIENT, db, now: () => new Date(at),
    webhook: 'https://webhook.example.invalid/synthetic-secret', waitUntil: (work) => { background.push(work); }, fetch: send });
  const controller = createIntakeController({ clientId: CLIENT, repository, notifications,
    now: () => new Date(at), budget: { maxMetadataBytes: 2048, maxFileBytes: 4096 },
    originals: new MemoryOriginals(), authorizeUpload: uploadAuthority([CASE_A]) });
  const operationId = 'synthetic-single-file-0001', bytes = syntheticPdf('single-notification');
  const request = (pdf: boolean) => {
    const url = new URL('https://client-a.example.invalid/client/intake/case-a/submissions');
    return { request: new Request(url, { method: pdf ? 'PUT' : 'POST',
      headers: { origin: url.origin, 'content-type': pdf ? 'application/pdf' : 'application/json' },
      body: pdf ? bytes as BodyInit : JSON.stringify({ operationId, path: 'single.pdf', mediaType: 'application/pdf', size: bytes.length, sha256: hex(bytes) }) }),
    url, params: { caseId: CASE_A, operationId }, identity: identity() };
  };
  return { db, repository, notifications, background, operationId, bytes,
    declare: () => controller.declare(request(false)), upload: () => controller.upload(request(true)) };
}

it('19 one-file upload records one notification, sends files:1 once and appears New to the operator', async () => {
  let finish!: (response: Response) => void;
  const send = vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve; }));
  const w = singleWorld(send);
  expect((await w.declare()).status).toBe(201);
  expect(w.db.rows('SELECT * FROM sub_notification')).toEqual([]);
  expect((await w.upload()).status).toBe(201);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(w.db.rows('SELECT submission_id, delivered_at FROM sub_notification')).toEqual([{ submission_id: w.operationId, delivered_at: null }]);
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({ caseId: CASE_A, submissionId: w.operationId, files: 1, bytes: w.bytes.length, at });
  const operator = createOperatorDownloadController({ clientId: CLIENT, repository: w.repository, notifications: w.notifications,
    authorizeOperate: operateAuthority([CASE_A]), assets: new MemoryAssets(), audit: new MemoryAudit(), now: () => new Date(at) });
  const url = new URL('https://client-a.example.invalid/operator/submissions/case-a');
  const list = () => operator.list({ request: new Request(url), url, params: { caseId: CASE_A }, identity: operatorIdentity() });
  expect(await (await list()).json()).toMatchObject({ submissions: [{ operationId: w.operationId, fileCount: 1, isNew: true }] });
  expect((await w.upload()).status).toBe(200);
  finish(new Response(null, { status: 204 }));
  await Promise.all(w.background);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await w.notifications.pending(scope)).toEqual([]);
  expect(w.db.rows('SELECT submission_id FROM sub_notification')).toEqual([{ submission_id: w.operationId }]);
  expect(await (await list()).json()).toMatchObject({ submissions: [{ operationId: w.operationId, isNew: false }] });
});

it('19 one-file finalization rolls back if its notification cannot be stored and retries safely', async () => {
  const w = singleWorld(vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));
  expect((await w.declare()).status).toBe(201);
  w.db.sqlite.exec("CREATE TRIGGER fail_single_notification BEFORE INSERT ON sub_notification BEGIN SELECT RAISE(ABORT, 'synthetic full disk'); END");
  expect((await w.upload()).status).toBe(503);
  expect(w.db.rows('SELECT state FROM submissions_upload')).toEqual([{ state: 'reserved' }]);
  expect(w.db.rows('SELECT * FROM sub_notification')).toEqual([]);
  w.db.sqlite.exec('DROP TRIGGER fail_single_notification');
  expect((await w.upload()).status).toBe(201);
  await Promise.all(w.background);
  expect(await w.notifications.pending(scope)).toEqual([w.operationId]);
});
