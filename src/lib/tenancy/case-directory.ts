import type { CaseId, ClientId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { LAYOUT } from '../storage/cloud/gate.ts';
import type { CaseDirectory } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';

// The actual CaseDirectory (GRS-114 port, GRS-115 rows): a read-only view of this client's own `rs_case` table. There is
// no second registry. The database is bound to one client by its `rs_storage_identity` row, so that row is read in the
// same statement as the case and must name this deployment's client (from trusted configuration, never a request) in the
// layout this code knows. A database that is unbound, bound to another client or in another layout answers "no case", so
// it confers no authority. Only SELECT statements are issued: asking never creates, repairs or touches a case. Cases come
// into being only through trusted provisioning (case-provisioning.ts, which is not exported from the tenancy index).

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** What the client's database says about one case id. `foreign` means the database is not provably this client's. */
export type CaseLookup = { kind: 'foreign' } | { kind: 'absent' } | { kind: 'present'; title: string | null };

type Row = { client_id: string; layout: string; case_id: string | null; case_label: string | null };

/**
 * One read-only statement: the identity row, left-joined to the case. A storage fault is a retryable storage-unavailable.
 * It is exported for the provisioning module (which must make the same identity check before any write), not for requests.
 */
export async function lookupCase(db: D1, deployment: Pick<ClientResourceIdentity, 'clientId'>, caseId: CaseId | string): Promise<CaseLookup> {
  if (typeof caseId !== 'string' || !CASE_ID.test(caseId)) return { kind: 'absent' };
  let row: Row | null;
  try {
    row = await db
      .prepare('SELECT i.client_id AS client_id, i.layout AS layout, c.case_id AS case_id, c.case_label AS case_label FROM rs_storage_identity i LEFT JOIN rs_case c ON c.case_id = ? WHERE i.singleton = 1')
      .bind(caseId)
      .first<Row>();
  } catch {
    throw contractError('storage-unavailable', true);
  }
  if (!row || row.client_id !== deployment.clientId || row.layout !== LAYOUT) return { kind: 'foreign' };
  return row.case_id === caseId ? { kind: 'present', title: typeof row.case_label === 'string' ? row.case_label : null } : { kind: 'absent' };
}

/** The CaseDirectory of one client deployment over its D1 database. Unknown, foreign and malformed cases all answer false. */
export function d1CaseDirectory(a: { db: D1; deployment: Pick<ClientResourceIdentity, 'clientId'> }): CaseDirectory {
  if (typeof a?.db?.prepare !== 'function' || typeof a.deployment?.clientId !== 'string') throw new TypeError('the case directory needs a D1 database and the validated deployment');
  const { db, deployment } = a;
  return {
    async exists({ clientId, caseId }: { clientId: ClientId; caseId: CaseId }) {
      if (clientId !== deployment.clientId) return false; // another client's case is never answered, and nothing is read
      return (await lookupCase(db, deployment, caseId)).kind === 'present';
    },
  };
}
