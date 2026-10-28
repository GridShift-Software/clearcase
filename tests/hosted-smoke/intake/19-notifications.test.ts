import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CASE_A, CASE_B } from './doubles.ts';
import { at, setId, scope, migration, notificationWorld } from './19-fixture.ts';

describe('19 sealed intake notifications', () => {
  it('records once, returns while the webhook is pending, and delivers the exact synthetic counts once', async () => {
    let finish!: (r: Response) => void;
    const send = vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve; }));
    const w = await notificationWorld(send);
    expect((await w.seal()).status).toBe(201);
    expect(w.background).toHaveLength(1);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(await w.notifications.pending(scope)).toEqual([setId]);
    expect(await w.notifications.pending({ ...scope, caseId: CASE_B })).toEqual([]);
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({ caseId: CASE_A, submissionId: setId,
      files: 2, bytes: w.files.reduce((sum, f) => sum + f.size, 0), at });
    expect(send.mock.calls[0]![1]!.redirect).toBe('error');
    expect((await w.seal()).status).toBe(200);
    const manifest = await w.repository.revision({ ...scope, operationId: setId });
    w.notifications.sealed(manifest!); // concurrent/replayed scheduling also claims only once
    finish(new Response(null, { status: 204 }));
    await Promise.all(w.background);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await w.notifications.pending(scope)).toEqual([]);
    expect(w.db.rows('SELECT created_at, delivered_at FROM sub_notification')).toEqual([{ created_at: at, delivered_at: at }]);
  });

  it.each(['http', 'throw', 'unset'])('keeps uploads successful and notifications new on %s', async (failure) => {
    const send = vi.fn<typeof fetch>(async () => { if (failure === 'throw') throw new Error('synthetic network fault'); return new Response(null, { status: 503 }); });
    const w = await notificationWorld(send, failure !== 'unset');
    expect((await w.seal()).status).toBe(201);
    await Promise.all(w.background);
    expect(await w.notifications.pending(scope)).toEqual([setId]);
    expect(send).toHaveBeenCalledTimes(failure === 'unset' ? 0 : 1);
  });

  it('rolls back the sealed state when the notification cannot be stored, then recovers on retry', async () => {
    const w = await notificationWorld(vi.fn<typeof fetch>(), false);
    w.db.sqlite.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON sub_notification BEGIN SELECT RAISE(ABORT, 'synthetic full disk'); END");
    expect((await w.seal()).status).toBe(503);
    expect(w.db.rows('SELECT state FROM submissions_set')).toEqual([{ state: 'sealing' }]);
    expect(w.db.rows('SELECT * FROM sub_notification')).toEqual([]);
    w.db.sqlite.exec('DROP TRIGGER fail_notification');
    expect((await w.seal()).status).toBe(201);
    expect(await w.notifications.pending(scope)).toEqual([setId]);
  });

  it('ships exactly the same additive migration to staging', () => {
    expect(readFileSync(new URL('../../../deploy/staging/migrations/0012_intake_notification.sql', import.meta.url), 'utf8')).toBe(readFileSync(migration, 'utf8'));
  });
});
