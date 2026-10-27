// Synthetic grant rows exercised through the real observation SQL on the local SQLite D1 adapter.
import { expect, it } from 'vitest';
import { d1OperateObservation } from '../../../src/lib/tenancy/operate-observation.ts';
import { CASE, now } from '../recovery-native-adapters/world.ts';
import { nativeWorld } from './world.ts';

it('refuses corrupt expiry shapes even when SQLite parses them as future dates', async () => {
  const w = await nativeWorld();
  try {
    const observation = d1OperateObservation({ db: w.db, deployment: w.resources.deployment, now });
    const subject = { principal: w.identity.principal!, sessionId: w.identity.sessionId!, caseId: CASE };
    for (const expiry of [null, '2099-01-01T00:00:00.000Z']) {
      w.db.exec("UPDATE tenant_case_grants SET expires_at = ? WHERE grant_id = 'operator'", expiry);
      await expect(observation.observe(subject)).resolves.toBeUndefined();
    }
    for (const expiry of ['2480000.5', '2099-01-01 00:00:00', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00.000+00:00', 'not-a-date', '2020-01-01T00:00:00.000Z']) {
      w.db.exec("UPDATE tenant_case_grants SET expires_at = ? WHERE grant_id = 'operator'", expiry);
      await expect(observation.observe(subject), expiry).rejects.toMatchObject({ code: 'forbidden' });
    }
  } finally { w.close(); }
});
