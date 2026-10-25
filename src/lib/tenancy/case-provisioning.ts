import type { CaseId, SystemAuditActor } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { id } from '../server/runtime/ids.ts';
import { LAYOUT } from '../storage/cloud/gate.ts';
import type { ProvisioningAuditPort } from './audit.ts';
import { canonical } from './audit.ts';
import { lookupCase } from './case-directory.ts';
import type { ClientResourceIdentity } from './manifest.ts';

// PROVISIONING ONLY. Trusted, non-request creation of a synthetic case in this client's database, so the alpha has a case
// before any results or upload exist. It is deliberately NOT exported from ./index.ts and must never be reachable from
// request code (the hosted import guard must fail any hosted-graph edge to this file). No request path provisions a case;
// a read through the directory never writes. Its audit port records a SYSTEM actor (audit/provisioning.ts); it never
// records, builds or accepts a verified identity.
//
// What a case is: one `rs_case` row (case_id, case_label), the row every storage adapter statement refers to (uploads,
// versions, publication). Nothing else is needed for an empty case: no publication row means no publication. The
// database's `rs_storage_identity` row is provisioned with the database and must already name this deployment's client;
// the insert is guarded by it in the same statement, so a case is never written into an unbound or foreign database.
// The case belongs to this client through that identity; there is no separate owner column, and the case id and title are
// immutable once created (a replay with the same values is a no-op, anything else is a conflict).

export interface CaseProvisioningOptions {
  deployment: ClientResourceIdentity;
  db: D1;
  audit: ProvisioningAuditPort;
  now: () => Date;
}
export type ProvisionCaseResult =
  | { kind: 'provisioned'; caseId: CaseId; title: string; repeated: boolean }
  | { kind: 'invalid'; reason: string }
  /** The database holds no identity row, or one naming another client or layout. Nothing was written. */
  | { kind: 'refused'; reason: 'storage-identity' }
  /** The case id exists with a different title, or the audit log holds a different event under the case's event id. */
  | { kind: 'conflict'; reason: 'title-differs' | 'audit-mismatch' }
  /** The case row is in place but its audit event is not confirmed persisted. Replaying the same call completes it. */
  | { kind: 'audit-pending'; caseId: CaseId; retryable: true };

export const CASE_PROVISION_ACTION = 'case.provision';
const CASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/; // no ':' (the audit envelope's case id forbids it) and short enough for the event id
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// A title a person will read: no controls (C0, DEL, C1), no bidirectional overrides or isolates, no edge whitespace.
const validTitle = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && s === s.trim() && s.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s);
const storage = () => contractError('storage-unavailable', true);

export function createCaseProvisioning(o: CaseProvisioningOptions) {
  if (typeof o?.db?.prepare !== 'function' || typeof o.audit?.append !== 'function' || typeof o.audit?.find !== 'function' || typeof o.deployment?.clientId !== 'string') {
    throw new TypeError('case provisioning needs a D1 database, the validated deployment and a provisioning audit port with append and find');
  }
  const { db, deployment } = o;
  const fault = <T>(p: Promise<T>) => p.catch(() => { throw storage(); });

  /** The one audit event of a case's creation: a stable id per case, so a replay finds or appends the same event. */
  const eventFor = (caseId: CaseId, operator: string) => ({
    eventId: `case-provision:${caseId}`,
    actor: { kind: 'system', component: 'provisioning', operator } satisfies SystemAuditActor,
    action: CASE_PROVISION_ACTION,
    object: { kind: 'case', id: caseId, caseId },
    version: null,
    outcome: 'succeeded' as const,
    at: o.now().toISOString(),
  });
  // The recorded event stands for the case whoever replays it: it must be this case's creation by the provisioning
  // component, whichever run label and instant it first carried. Anything else under the id is a mismatch.
  const sameEvent = (stored: unknown, e: ReturnType<typeof eventFor>) => {
    const s = stored as Partial<ReturnType<typeof eventFor>> | null;
    return !!s && canonical({ ...s, at: null, actor: { ...s.actor, operator: null } }) === canonical({ ...e, at: null, actor: { ...e.actor, operator: null } });
  };
  /** 'ok' only when a stored event matches: never inferred from an error string or a duplicate refusal. */
  async function persist(e: ReturnType<typeof eventFor>): Promise<'ok' | 'mismatch' | 'pending'> {
    const lookup = async (): Promise<'ok' | 'mismatch' | 'absent' | 'unknown'> => {
      try { const found = await o.audit.find(e.eventId); return found === null ? 'absent' : sameEvent(found, e) ? 'ok' : 'mismatch'; } catch { return 'unknown'; }
    };
    const first = await lookup();
    if (first === 'ok' || first === 'mismatch') return first;
    try { await o.audit.append(e); return 'ok'; } catch {
      const again = await lookup(); // not acknowledged: only a matching stored event is proof
      return again === 'ok' || again === 'mismatch' ? again : 'pending';
    }
  }

  return {
    /** Creates the case, or confirms the identical one, then confirms its audit event. Idempotent and safe under concurrent calls. */
    async provisionCase(a: { operator: string; caseId: string; title: string }): Promise<ProvisionCaseResult> {
      if (typeof a?.operator !== 'string' || !OPERATOR.test(a.operator)) return { kind: 'invalid', reason: 'operator is invalid' };
      if (typeof a.caseId !== 'string' || !CASE.test(a.caseId)) return { kind: 'invalid', reason: 'caseId is invalid' };
      if (!validTitle(a.title)) return { kind: 'invalid', reason: 'title is invalid' };
      const caseId = id('case', a.caseId), title = a.title;
      let seen = await lookupCase(db, deployment, caseId);
      if (seen.kind === 'foreign') return { kind: 'refused', reason: 'storage-identity' };
      let repeated = true;
      if (seen.kind === 'absent') {
        // Guarded by the identity row in the same statement; a concurrent creator makes this a no-op, and the read decides.
        await fault(db.prepare('INSERT INTO rs_case (case_id, case_label) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM rs_storage_identity WHERE singleton = 1 AND client_id = ? AND layout = ?) ON CONFLICT DO NOTHING')
          .bind(caseId, title, deployment.clientId, LAYOUT).run());
        seen = await lookupCase(db, deployment, caseId);
        if (seen.kind === 'foreign') return { kind: 'refused', reason: 'storage-identity' };
        if (seen.kind !== 'present') throw storage(); // the guarded insert neither wrote nor lost a race: a fault, never a result
        repeated = false;
      }
      if (seen.title !== title) return { kind: 'conflict', reason: 'title-differs' };
      const verdict = await persist(eventFor(caseId, a.operator));
      if (verdict === 'mismatch') return { kind: 'conflict', reason: 'audit-mismatch' };
      if (verdict === 'pending') return { kind: 'audit-pending', caseId, retryable: true };
      return { kind: 'provisioned', caseId, title, repeated };
    },
  };
}
