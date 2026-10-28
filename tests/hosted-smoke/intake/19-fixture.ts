import { expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createIntakeController } from '../../../src/lib/submissions/controller.ts';
import { intakeNotifications } from '../../../src/lib/submissions/notifications.ts';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';
import { d1SubmissionRepository } from '../../../src/lib/submissions/repository.ts';
import { CASE_A, CASE_B, CLIENT, MemoryOriginals, SqliteD1, hex, identity, syntheticPdf, uploadAuthority } from './doubles.ts';
import { MIGRATIONS } from './harness.ts';

export const migration = fileURLToPath(new URL('../../../src/lib/submissions/migrations/0003_intake_notification.sql', import.meta.url));
export const at = '2026-10-28T14:00:00.000Z';
export const setId = 'synthetic-set-00000001';
export const scope = { clientId: CLIENT, caseId: CASE_A };

export async function notificationWorld(send: typeof fetch, configured = true) {
  const db = new SqliteD1([...MIGRATIONS, migration]);
  const repository = d1SubmissionRepository(db), background: Promise<void>[] = [];
  const notifications = intakeNotifications({ clientId: CLIENT, db, now: () => new Date(at),
    webhook: configured ? 'https://webhook.example.invalid/secret' : undefined,
    waitUntil: (work) => { background.push(work); }, fetch: send });
  const controller = createIntakeController({ clientId: CLIENT, repository, notifications,
    now: () => new Date(at), budget: { maxMetadataBytes: 2048, maxFileBytes: 4096 },
    originals: new MemoryOriginals(), authorizeUpload: uploadAuthority([CASE_A]) });
  const request = (method: string, body: unknown, operationId?: string, pdf = false) => {
    const url = new URL('https://client-a.example.invalid/client/intake/case-a');
    return { request: new Request(url, { method, headers: { origin: url.origin, 'content-type': pdf ? 'application/pdf' : 'application/json' },
      body: pdf ? body as BodyInit : JSON.stringify(body) }), url, identity: identity(), params: { caseId: CASE_A, setId, operationId } };
  };
  const files = [0, 1].map((n) => { const bytes = syntheticPdf(`notification-${n}`); return { bytes,
    operationId: `synthetic-file-0000000${n}`, path: `${n}.pdf`, mediaType: 'application/pdf', size: bytes.length, sha256: hex(bytes) }; });
  expect((await controller.openSet(request('POST', { setId, fileCount: 2, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }))).status).toBe(201);
  for (const { bytes, ...file } of files) {
    expect((await controller.declareSetFile(request('POST', file))).status).toBe(201);
    expect((await controller.uploadSetFile(request('PUT', bytes, file.operationId, true))).status).toBe(201);
  }
  const digest = await fileSetDigest(files);
  return { db, repository, notifications, background, files,
    seal: () => controller.sealSet(request('POST', { filesSha256: digest })) };
}

