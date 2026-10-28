import { expect, it, vi } from 'vitest';
import { createOperatorDownloadController } from '../../../src/lib/submissions/download/controller.ts';
import { CASE_A, CASE_B, CLIENT, MemoryAssets, MemoryAudit, identity, operateAuthority } from '../operator-download/doubles.ts';
import { notificationWorld, setId, at } from './19-fixture.ts';

it('19 operator list marks undelivered submissions new only after admitting the operator and case', async () => {
  const w = await notificationWorld(vi.fn<typeof fetch>(), false);
  expect((await w.seal()).status).toBe(201);
  const pending = vi.spyOn(w.notifications, 'pending');
  const audit = new MemoryAudit();
  const controller = createOperatorDownloadController({ clientId: CLIENT, repository: w.repository,
    notifications: w.notifications, authorizeOperate: operateAuthority([CASE_A]), assets: new MemoryAssets(), audit,
    now: () => new Date(at) });
  const request = (caseId = CASE_A, who = identity()) => {
    const url = new URL(`https://client-a.example.invalid/operator/submissions/${caseId}`);
    return { request: new Request(url), url, params: { caseId }, identity: who };
  };
  expect((await controller.list(request(CASE_B))).status).toBe(404);
  expect((await controller.list(request(CASE_A, identity({ principalKind: 'client' })))).status).toBe(404);
  expect((await controller.list(request(CASE_A, identity({ revoked: true })))).status).toBe(401);
  expect(pending).not.toHaveBeenCalled();
  const response = await controller.list(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ submissions: [{ operationId: setId, isNew: true, fileCount: 2 }] });
  expect(audit.events).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'operator.submission.list.intent' })]));
  w.db.exec('UPDATE sub_notification SET delivered_at = ?', at);
  expect(await (await controller.list(request())).json()).toMatchObject({ submissions: [{ operationId: setId, isNew: false }] });
  pending.mockRejectedValueOnce(new Error('synthetic notification read outage'));
  const unavailableMarker = await controller.list(request());
  expect(unavailableMarker.status).toBe(200);
  const body = await unavailableMarker.json() as { submissions: { operationId: string; isNew?: boolean }[] };
  expect(body.submissions[0]!.operationId).toBe(setId);
  expect(body.submissions[0]).not.toHaveProperty('isNew');
});
