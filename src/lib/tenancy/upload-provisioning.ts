import { validCaseId, validEventId } from '../server/runtime/audit-identifiers.ts';
import type { CaseId, ClientId, Principal, SystemAuditActor } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import type { D1, D1Statement } from '../server/runtime/hosted/bindings.ts';
import { id } from '../server/runtime/ids.ts';
import { canonical, digestOf, type AnyAuditEvent, type ProvisioningAuditPort } from './audit.ts';
import { belongs } from './authorizer.ts';
import type { CaseDirectory } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';
import { OPERATION, isIso, sameActor, storage } from './operations.ts';
import { UPLOAD_COLUMNS, parseUploadGrant, uploadPin, type UploadGrant, type UploadGrantee, type UploadRow } from './upload-capability.ts';

// PROVISIONING ONLY (NATIVE24). The trusted, non-request entry that issues and revokes the distinct case.upload-originals
// grant, and the one step that binds a client's database. It is deliberately NOT exported from ./index.ts and must never
// be reachable from request code: no HTTP route, manager, grant-admin, staff or Global Admin path calls it, and
// request-serving code holds only the reader in upload-capability.ts. The hosted import guard (scripts/ci/hosted-imports.ts)
// does not yet name this file; that is a parent handoff (see docs/hosted-foundation/upload-grants.md).
//
// Authority is the deployment's trusted provisioning, nothing else. The operator label is attribution only: the ledger
// records `control-plane:<clientId>` plus the label, and the audit event records the honest system actor
// { kind: 'system', component: 'provisioning', operator }, never a verified principal, issuer or session. The operator
// label confers no identity privilege and cannot be presented as a principal (a `control-plane:` issuer belongs to no
// deployment). Granting does not grant case access, and case access does not grant upload.
//
// A grant is stored pending and becomes active only after its audit event is confirmed persisted by the provisioning
// audit port (a lookup by event id, an append, and a byte-identical read-back after a lost acknowledgement). The table
// enforces the same (migrations/0003). A revoke takes effect first and its event is confirmed after, so a failed
// append never leaves access standing.

export type UploadOperationType = 'issue' | 'revoke';
export interface UploadGrantOperation {
  readonly operationId: string;
  readonly operation: UploadOperationType;
  readonly actor: { issuer: string; subject: string; kind: 'control-plane' };
  readonly request: string;
  readonly grantId: string;
  readonly event: string;
  readonly eventDigest: string;
  readonly state: 'recorded' | 'audited';
  readonly recordedAt: string;
}
type NewOperation = Omit<UploadGrantOperation, 'state'>;

export type UploadResult =
  | { kind: 'applied'; grant: UploadGrant; repeated: boolean }
  /** The expected version is not the current one, or the grant is not in a state the change applies to. */
  | { kind: 'stale' }
  | { kind: 'gone' }
  /** A live grant holds the tuple; the operation id belongs to another operator, type or request; or the log holds a different event under the operation's event id. */
  | { kind: 'conflict'; reason: 'slot-taken' | 'operation-reused' | 'audit-mismatch' }
  | { kind: 'invalid'; reason: string }
  /** The audit event is not confirmed persisted. An issue is stored pending and grants nothing; a revoke is already in force. Retrying with the same operation id completes it. */
  | { kind: 'audit-pending'; grantId: string; retryable: true };

export interface UploadProvisioningOptions {
  deployment: ClientResourceIdentity;
  /** This client's own D1 database. Every query and write first proves it is the database bound to this client. */
  db: D1;
  cases: CaseDirectory;
  /** The provisioning port (src/lib/audit/provisioning.ts): a system-event append plus find. A request sink cannot stand in. */
  audit: ProvisioningAuditPort;
  now: () => Date;
  newGrantId?: () => string;
}

const REUSED = { kind: 'conflict', reason: 'operation-reused' } as const;
const isConstraint = (e: unknown) => e instanceof Error && /constraint/i.test(e.message);

/**
 * Binds a client's database to exactly this client and D1 database id, once, from provisioning. Idempotent for the same
 * client; rejects when the database is bound to another one. A request never calls it, and nothing binds an empty database
 * on first use: until this runs, every query and write against the upload tables is a fault.
 */
export async function bindUploadDatabase(db: D1, deployment: Pick<ClientResourceIdentity, 'clientId' | 'd1DatabaseId'>): Promise<void> {
  await db.prepare('INSERT INTO tenant_upload_binding (singleton, client_id, d1_database_id) VALUES (1, ?, ?) ON CONFLICT DO NOTHING').bind(deployment.clientId, deployment.d1DatabaseId).run();
  await uploadPin(db, deployment)();
}

const OPERATION_COLUMNS = 'operation_id, operation, actor_issuer, actor_subject, actor_kind, request, grant_id, event_json, event_digest, state, recorded_at';
type OperationRow = { operation_id: string; operation: string; actor_issuer: string; actor_subject: string; actor_kind: string; request: string; grant_id: string; event_json: string; event_digest: string; state: string; recorded_at: string };
function parseOperation(r: OperationRow): UploadGrantOperation {
  if ((r.operation !== 'issue' && r.operation !== 'revoke') || r.actor_kind !== 'control-plane' || (r.state !== 'recorded' && r.state !== 'audited')) throw new Error('malformed upload operation row');
  return Object.freeze({
    operationId: r.operation_id, operation: r.operation, actor: Object.freeze({ issuer: r.actor_issuer, subject: r.actor_subject, kind: 'control-plane' as const }),
    request: r.request, grantId: r.grant_id, event: r.event_json, eventDigest: r.event_digest, state: r.state, recordedAt: r.recorded_at,
  });
}
const operationValues = (clientId: string, o: NewOperation) => [clientId, o.operationId, o.operation, o.actor.issuer, o.actor.subject, o.actor.kind, o.request, o.grantId, o.event, o.eventDigest, o.recordedAt];
/** Inserts the ledger row only when the grant change it records is in the batch. A taken operation id is a constraint error, which rolls the whole batch back. */
const OPERATION_INSERT = `INSERT INTO tenant_upload_grant_operations (client_id, operation_id, operation, actor_issuer, actor_subject, actor_kind, request, grant_id, event_json, event_digest, recorded_at, state) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded' WHERE EXISTS (`;

/** The write side of the upload tables, over this client's pinned database. Not exported: only the provisioning factory holds it. */
function uploadGrantStore(db: D1, deployment: Pick<ClientResourceIdentity, 'clientId' | 'd1DatabaseId'>) {
  const { clientId } = deployment, pinned = uploadPin(db, deployment);
  const get = async (grantId: string): Promise<UploadGrant | null> => {
    await pinned();
    const r = await db.prepare(`SELECT ${UPLOAD_COLUMNS} FROM tenant_upload_grants g WHERE g.client_id = ? AND g.grant_id = ?`).bind(clientId, grantId).first<UploadRow>();
    return r ? parseUploadGrant(r, clientId) : null;
  };
  const operationOf = async (operationId: string): Promise<UploadGrantOperation | null> => {
    await pinned();
    const r = await db.prepare(`SELECT ${OPERATION_COLUMNS} FROM tenant_upload_grant_operations WHERE client_id = ? AND operation_id = ?`).bind(clientId, operationId).first<OperationRow>();
    return r ? parseOperation(r) : null;
  };
  /** A constraint violation is a logical conflict (a lost race, a taken slot or operation id); anything else is a storage fault and surfaces as one. */
  const batch = async (statements: D1Statement[]) => {
    await pinned();
    try { await db.batch(statements); } catch (e) { if (!isConstraint(e)) throw e; /* rolled back: the read that follows decides */ }
  };
  /** Both the grant change and its ledger row, for this exact operation, or neither. */
  const recorded = async (grantId: string, op: NewOperation) => {
    const stored = await get(grantId), row = await operationOf(op.operationId);
    return stored && row && row.grantId === grantId && row.request === op.request && row.eventDigest === op.eventDigest ? stored : null;
  };
  return {
    get, operationOf,
    async insertPending(a: { grant: Omit<UploadGrant, 'state' | 'version' | 'revokedOperationId' | 'revokedAt'>; operation: NewOperation }): Promise<UploadGrant | null> {
      const g = a.grant;
      await batch([
        db.prepare(`INSERT INTO tenant_upload_grants (grant_id, client_id, case_id, issuer, subject, principal_kind, state, version, expires_at, created_operation_id, request, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .bind(g.grantId, clientId, g.caseId, g.issuer, g.subject, g.principalKind, g.expiresAt, g.createdOperationId, g.request, g.createdAt),
        db.prepare(`${OPERATION_INSERT}SELECT 1 FROM tenant_upload_grants WHERE client_id = ? AND grant_id = ? AND created_operation_id = ?)`).bind(...operationValues(clientId, a.operation), clientId, g.grantId, a.operation.operationId),
      ]);
      const stored = await recorded(g.grantId, a.operation);
      return stored && stored.createdOperationId === g.createdOperationId ? stored : null;
    },
    /** Moves a pending grant to active at its version, only when its issue operation is already audited; null otherwise. */
    async activate(a: { grantId: string; version: number }): Promise<UploadGrant | null> {
      await pinned();
      await db.prepare(`UPDATE tenant_upload_grants SET state = 'active', version = version + 1 WHERE client_id = ? AND grant_id = ? AND version = ? AND state = 'pending'
        AND EXISTS (SELECT 1 FROM tenant_upload_grant_operations o WHERE o.client_id = tenant_upload_grants.client_id AND o.operation_id = tenant_upload_grants.created_operation_id AND o.operation = 'issue' AND o.state = 'audited')`)
        .bind(clientId, a.grantId, a.version).run();
      const stored = await get(a.grantId);
      return stored?.state === 'active' && stored.version === a.version + 1 ? stored : null;
    },
    async revoke(a: { grantId: string; expectedVersion: number; operation: NewOperation; at: string }): Promise<UploadGrant | null> {
      await batch([
        db.prepare("UPDATE tenant_upload_grants SET state = 'revoked', version = version + 1, revoked_operation_id = ?, revoked_at = ? WHERE client_id = ? AND grant_id = ? AND version = ? AND state IN ('pending', 'active')")
          .bind(a.operation.operationId, a.at, clientId, a.grantId, a.expectedVersion),
        db.prepare(`${OPERATION_INSERT}SELECT 1 FROM tenant_upload_grants WHERE client_id = ? AND grant_id = ? AND revoked_operation_id = ?)`).bind(...operationValues(clientId, a.operation), clientId, a.grantId, a.operation.operationId),
      ]);
      const stored = await recorded(a.grantId, a.operation);
      return stored?.state === 'revoked' && stored.revokedOperationId === a.operation.operationId ? stored : null;
    },
    /** Marks the operation's audit event as confirmed persisted; true when the row is now `audited`. */
    async settle(operationId: string): Promise<boolean> {
      await pinned();
      await db.prepare("UPDATE tenant_upload_grant_operations SET state = 'audited' WHERE client_id = ? AND operation_id = ? AND state = 'recorded'").bind(clientId, operationId).run();
      return (await operationOf(operationId))?.state === 'audited';
    },
  };
}

/**
 * The trusted authority for case.upload-originals. Provisioning composes it from deployment configuration in a
 * provisioning job; it is not a capability any grant, role or request can confer.
 */
export function createUploadProvisioning(o: UploadProvisioningOptions) {
  if (typeof o?.audit?.append !== 'function' || typeof o.audit.find !== 'function') throw new TypeError('upload provisioning needs an audit port with append and find(eventId): an append-only sink cannot prove whether a lost acknowledgement persisted');
  if (typeof o.db?.prepare !== 'function' || typeof o.db.batch !== 'function' || typeof o.cases?.exists !== 'function' || typeof o.now !== 'function' || typeof o.deployment?.clientId !== 'string') throw new TypeError('upload provisioning needs the deployment, its database, a case directory and a clock');
  const { deployment } = o, clientId = deployment.clientId as ClientId, store = uploadGrantStore(o.db, deployment), newGrantId = o.newGrantId ?? (() => crypto.randomUUID());
  const db = <T>(p: Promise<T>) => p.catch(() => { throw storage(); });
  const control = (operator: string) => ({ issuer: `control-plane:${clientId}`, subject: operator, kind: 'control-plane' as const });

  /** Fixes the audit event of an operation: built once, here, and never rebuilt by a retry. */
  async function record(a: { operationId: string; operation: UploadOperationType; operator: string; request: string; grantId: string; caseId: CaseId }): Promise<NewOperation> {
    const at = o.now().toISOString();
    const actor: SystemAuditActor = { kind: 'system', component: 'provisioning', operator: a.operator };
    // Keep existing short ids stable for replay. Long ids use a disjoint namespace and the full client/operation
    // digest, not truncation (which aliases operations differing only in their suffix). Both forms fit the real sink.
    const literal = `upload-grant-op:${a.operationId}`;
    const eventId = validEventId(literal) ? literal : `upload-grant-hash:${await digestOf(canonical([clientId, a.operationId]))}`;
    const event = { eventId, actor, action: `grant.upload.${a.operation}`, object: { kind: 'upload-grant', id: a.grantId, caseId: a.caseId }, version: null, outcome: 'succeeded', at } as AnyAuditEvent;
    const json = canonical(event);
    return { operationId: a.operationId, operation: a.operation, actor: control(a.operator), request: a.request, grantId: a.grantId, event: json, eventDigest: await digestOf(json), recordedAt: at };
  }

  /**
   * Confirms the operation's own recorded event is persisted: looks it up; appends it when absent; after a failed append
   * reads it back. 'ok' only when the stored event is byte-identical (canonical) to the recorded one, and the recorded
   * one is a system event of this feature. Never infers success from a duplicate or an error string.
   */
  async function persist(op: UploadGrantOperation): Promise<'ok' | 'mismatch' | 'pending'> {
    let event: AnyAuditEvent;
    try {
      event = JSON.parse(op.event) as AnyAuditEvent;
      if (canonical(event) !== op.event || (await digestOf(op.event)) !== op.eventDigest) return 'mismatch'; // the recorded row was altered
      if ((event.actor as { kind?: string }).kind !== 'system' || event.object?.kind !== 'upload-grant' || event.object.id !== op.grantId) return 'mismatch';
    } catch { return 'mismatch'; }
    const lookup = async (): Promise<'ok' | 'mismatch' | 'absent' | 'unknown'> => {
      try { const found = await o.audit.find(event.eventId); return found === null ? 'absent' : canonical(found) === op.event ? 'ok' : 'mismatch'; } catch { return 'unknown'; }
    };
    const first = await lookup();
    if (first === 'ok' || first === 'mismatch') return first;
    try {
      await o.audit.append(event as Parameters<ProvisioningAuditPort['append']>[0]); // acknowledged: persisted
      return 'ok';
    } catch {
      const again = await lookup(); // not acknowledged: only a matching stored event is proof
      return again === 'ok' || again === 'mismatch' ? again : 'pending';
    }
  }

  /**
   * Settles an operation. The event must be confirmed persisted and its ledger row audited BEFORE a pending grant
   * activates (the table refuses it otherwise), and a revoked grant never activates.
   */
  async function complete(op: UploadGrantOperation, grant: UploadGrant, repeated: boolean): Promise<UploadResult> {
    if (op.state === 'recorded') {
      if (op.operation === 'issue' && grant.state === 'revoked') return { kind: 'stale' }; // revoked before it ever took effect
      const verdict = await persist(op);
      if (verdict === 'mismatch') return { kind: 'conflict', reason: 'audit-mismatch' };
      if (verdict === 'pending') return { kind: 'audit-pending', grantId: grant.grantId, retryable: true };
      if ((await db(store.settle(op.operationId))) !== true) throw storage();
    }
    let settled = grant;
    if (grant.state === 'pending') {
      const active = await db(store.activate({ grantId: grant.grantId, version: grant.version }));
      if (active) settled = active;
      else {
        const now = await db(store.get(grant.grantId));
        if (now?.state !== 'active') return { kind: 'stale' };
        settled = now; repeated = true;
      }
    }
    return { kind: 'applied', grant: settled, repeated };
  }

  /** A retried operation resumes only for the same operator, type and request that first used the id; anything else is refused without returning the other operation's grant. */
  async function again(operator: string, type: UploadOperationType, operationId: string, request: string): Promise<UploadResult | null> {
    const op = await db(store.operationOf(operationId));
    if (!op) return null;
    if (op.operation !== type || op.request !== request || !sameActor(op.actor, control(operator))) return REUSED;
    const grant = await db(store.get(op.grantId));
    if (!grant) throw storage(); // a ledger row without its grant is a fault, never a result
    return complete(op, grant, true);
  }

  return {
    /** Grants case.upload-originals on one case to one principal of this client or of staff. Never grants case access. */
    async grant(a: { operator: string; operationId: string; target: UploadGrantee; caseId: CaseId; expiresAt: string | null }): Promise<UploadResult> {
      if (typeof a?.operator !== 'string' || !OPERATION.test(a.operator)) return { kind: 'invalid', reason: 'operator is invalid' };
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      // Case identity must be representable unchanged in the real audit scope, before any tuple is reserved or resumed.
      if (!validCaseId(a.caseId)) return { kind: 'invalid', reason: 'caseId is invalid' };
      const request = JSON.stringify(['upload-issue', a.target?.issuer, a.target?.subject, a.target?.kind, a.caseId, a.expiresAt]);
      const resumed = await again(a.operator, 'issue', a.operationId, request);
      if (resumed) return resumed;
      const t = a.target;
      if (!t || typeof t.issuer !== 'string' || typeof t.subject !== 'string' || !t.subject || (t.kind !== 'client' && t.kind !== 'staff') || !belongs(deployment, t as Principal)) return { kind: 'invalid', reason: 'the target is not a principal of this client or of staff' };
      if (a.expiresAt !== null && (typeof a.expiresAt !== 'string' || !isIso(a.expiresAt))) return { kind: 'invalid', reason: 'expiresAt must be an exact ISO instant or null' };
      if (a.expiresAt !== null && Date.parse(a.expiresAt) <= o.now().getTime()) return { kind: 'invalid', reason: 'expiresAt is not in the future' };
      if ((await db(o.cases.exists({ clientId, caseId: a.caseId }))) !== true) return { kind: 'invalid', reason: 'unknown case' };
      const grantId = newGrantId();
      // The audit object's id has the same grammar as an event id. A bad injected generator must not poison a live slot.
      if (!validEventId(grantId)) return { kind: 'invalid', reason: 'grantId is invalid' };
      const operation = await record({ operationId: a.operationId, operation: 'issue', operator: a.operator, request, grantId, caseId: a.caseId });
      const stored = await db(store.insertPending({
        grant: { grantId, clientId, caseId: id('case', a.caseId), issuer: t.issuer, subject: t.subject, principalKind: t.kind, expiresAt: a.expiresAt, createdOperationId: a.operationId, request, createdAt: operation.recordedAt },
        operation,
      }));
      if (stored) return complete({ ...operation, state: 'recorded' }, stored, false);
      const raced = await again(a.operator, 'issue', a.operationId, request);
      if (raced) return raced;
      return { kind: 'conflict', reason: 'slot-taken' };
    },
    /** Revokes a pending or active upload grant at the expected version. In force before its audit event is confirmed. */
    async revoke(a: { operator: string; operationId: string; grantId: string; expectedVersion: number }): Promise<UploadResult> {
      if (typeof a?.operator !== 'string' || !OPERATION.test(a.operator)) return { kind: 'invalid', reason: 'operator is invalid' };
      if (typeof a.operationId !== 'string' || !OPERATION.test(a.operationId)) return { kind: 'invalid', reason: 'operationId is invalid' };
      const request = JSON.stringify(['upload-revoke', a.grantId, a.expectedVersion]);
      const resumed = await again(a.operator, 'revoke', a.operationId, request);
      if (resumed) return resumed;
      const old = typeof a.grantId === 'string' ? await db(store.get(a.grantId)) : null;
      if (!old) return { kind: 'gone' };
      if (old.state === 'revoked' || old.version !== a.expectedVersion) return { kind: 'stale' };
      const operation = await record({ operationId: a.operationId, operation: 'revoke', operator: a.operator, request, grantId: old.grantId, caseId: old.caseId });
      const revoked = await db(store.revoke({ grantId: old.grantId, expectedVersion: a.expectedVersion, operation, at: operation.recordedAt }));
      if (revoked) return complete({ ...operation, state: 'recorded' }, revoked, false);
      const raced = await again(a.operator, 'revoke', a.operationId, request);
      if (raced) return raced;
      return { kind: 'stale' };
    },
  };
}
