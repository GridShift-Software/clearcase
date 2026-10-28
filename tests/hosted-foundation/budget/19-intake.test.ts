import { describe, expect, it, vi } from 'vitest';
import { intakeUploadHolding } from '../../../src/lib/submissions/upload-holding.ts';
import { caseActions } from '../../../src/lib/views/hosted/case-actions.ts';
import { notificationWorld, scope, setId, at } from '../../hosted-smoke/intake/19-fixture.ts';
import { CASE_1, CASE_2, CLIENT_A, client, world } from '../upload-grant/world.ts';
import { countedD1, counters } from './harness.ts';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';

describe('19 intake budget and advisory grant boundary', () => {
  it('adds one D1 query for the action, shares the grant predicate, and hides another case or principal', async () => {
    const w = await world(), user = client('synthetic-upload-user'), c = counters();
    w.seedCase(user, 'viewer', CASE_1);
    const holding = intakeUploadHolding({ db: countedD1(w.handle, c), deployment: w.deployment, now: w.now });
    const request = { clientId: CLIENT_A, caseId: CASE_1, principal: user };
    const actions = async () => caseActions(CASE_1, await holding(request));
    expect(await actions()).not.toContainEqual(expect.objectContaining({ label: 'Upload documents' }));
    expect(c.d1).toBe(1);
    await expect(w.authorize(w.request(user))).rejects.toMatchObject({ code: 'forbidden' });
    const grant = await w.issue(user, CASE_1, 'synthetic-upload-issue');
    expect(grant.kind).toBe('applied');
    c.reset();
    expect(await actions()).toContainEqual({ label: 'Upload documents', href: `/client/intake/${CASE_1}` });
    expect(c.d1).toBe(1);
    await expect(w.authorize(w.request(user))).resolves.toBeUndefined();
    expect(await holding({ ...request, caseId: CASE_2 })).toBe(false);
    await expect(w.authorize(w.request(user, CASE_2))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await holding({ ...request, principal: client('another-user') })).toBe(false);
    await expect(w.authorize(w.request(client('another-user')))).rejects.toMatchObject({ code: 'forbidden' });
    console.log('19 shell action additional D1 queries: 1');
  });

  it('hides pending, expired and revoked upload grants as the authoritative upload denies them', async () => {
    const w = await world(), user = client('synthetic-expiring');
    w.seedCase(user, 'viewer', CASE_1);
    const holding = intakeUploadHolding({ db: w.handle, deployment: w.deployment, now: w.now });
    const request = { clientId: CLIENT_A, caseId: CASE_1, principal: user };
    w.state.auditFails = true;
    expect(await w.issue(user, CASE_1, 'synthetic-expiring', { expiresAt: '2026-10-25T08:01:00.000Z' })).toMatchObject({ kind: 'audit-pending' });
    expect(await holding(request)).toBe(false);
    await expect(w.authorize(w.request(user))).rejects.toMatchObject({ code: 'forbidden' });
    w.state.auditFails = false;
    const grant = await w.issue(user, CASE_1, 'synthetic-expiring', { expiresAt: '2026-10-25T08:01:00.000Z' });
    expect(await holding(request)).toBe(true);
    w.advance(60_000);
    expect(await holding(request)).toBe(false);
    await expect(w.authorize(w.request(user))).rejects.toMatchObject({ code: 'forbidden' });
    if (grant.kind !== 'applied') throw new Error('missing synthetic grant');
    await w.provisioning.revoke({ operator: 'provisioning-run-1', operationId: 'synthetic-revoke', grantId: grant.grant.grantId, expectedVersion: grant.grant.version });
    expect(await holding(request)).toBe(false);
    await expect(w.authorize(w.request(user))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('denies another client/database binding and does not turn advisory visibility into authority', async () => {
    const w = await world(), user = client('synthetic-bound');
    await w.issue(user, CASE_1, 'synthetic-binding');
    const wrong = intakeUploadHolding({ db: w.handle, deployment: { ...w.deployment, d1DatabaseId: '00000000-0000-4000-8000-00000000000c' }, now: w.now });
    expect(await wrong({ clientId: CLIENT_A, caseId: CASE_1, principal: user })).toBe(false);
    const holding = intakeUploadHolding({ db: w.handle, deployment: w.deployment, now: w.now });
    expect(await holding({ clientId: CLIENT_A, caseId: CASE_1, principal: client('synthetic-bound', 'https://client-c.example.test') })).toBe(false);
    await expect(w.authorize(w.request(client('synthetic-bound', 'https://client-c.example.test')))).rejects.toMatchObject({ code: 'wrong-client' });
    // Upload holding alone does not grant case access. The shell must first admit
    // the reader, and the authoritative mutation still denies this principal.
    expect(await holding({ clientId: CLIENT_A, caseId: CASE_1, principal: user })).toBe(true);
    await expect(w.authorize(w.request(user))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('commits the final seal and durable notification in one batch, without a webhook round trip', async () => {
    const send = vi.fn<typeof fetch>();
    const w = await notificationWorld(send, false);
    await w.repository.reserveSet({ ...scope, setId, at, filesSha256: await fileSetDigest(w.files) });
    await w.repository.markSetFilesFinalized({ ...scope, setId, operationIds: w.files.map((f) => f.operationId) });
    const batch = vi.spyOn(w.db, 'batch');
    await w.repository.commitSet({ ...scope, setId, at });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(w.db.rows('SELECT submission_id FROM sub_notification')).toEqual([{ submission_id: setId }]);
    expect(send).not.toHaveBeenCalled();
    console.log('19 final seal: 1 D1 batch, 0 webhook calls on response path');
  });
});
