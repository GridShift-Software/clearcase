// Trusted provisioning only (never a route, feature module or request): binds a migrated, empty user-work database to
// its client once. A request never binds or provisions; an unbound database refuses every user-work call.
import type { ClientId } from '../../server/runtime/contracts.ts';
import type { D1 } from '../../server/runtime/hosted/bindings.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { USER_WORK_SCHEMA_VERSION } from './d1-user-work.ts';

export async function provisionD1UserWork(a: { db: D1; clientId: ClientId; now(): Date }): Promise<{ clientId: ClientId; schemaVersion: number }> {
  if (!a?.db || typeof a.clientId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(a.clientId) || typeof a.now !== 'function') throw new TypeError('provisioning needs the database, the trusted clientId and a clock');
  try {
    await a.db.prepare('INSERT INTO uw_binding (singleton, client_id, schema_version, bound_at) VALUES (1, ?, ?, ?) ON CONFLICT (singleton) DO NOTHING')
      .bind(a.clientId, USER_WORK_SCHEMA_VERSION, a.now().toISOString()).run();
  } catch { /* decided by the read-back */ }
  const row = await a.db.prepare('SELECT client_id, schema_version FROM uw_binding WHERE singleton = 1').first<{ client_id: string; schema_version: number }>().catch(() => null);
  if (!row) throw contractError('storage-unavailable', true);
  // Another client's database, or another schema version, is never rebound or upgraded here.
  if (row.client_id !== a.clientId || Number(row.schema_version) !== USER_WORK_SCHEMA_VERSION) throw contractError('storage-unavailable');
  return { clientId: a.clientId, schemaVersion: USER_WORK_SCHEMA_VERSION };
}
