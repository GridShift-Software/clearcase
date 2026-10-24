import type { CaseId, CaseOperation, ClientId, Principal } from '../server/runtime/contracts.ts';

// Explicit, server-held grants. Nothing here comes from identity-provider metadata: a role, its expiry, its revocation
// and the case it names are rows this client's own database holds.

/** Case roles. viewer and editor reach case content; operator and publisher are separate capabilities for GRS-28/30/31. */
export type CaseRole = 'viewer' | 'editor' | 'operator' | 'publisher';
/** The client-level role that manages grants. It reaches no case content. */
export type ClientRole = 'grant-admin';
export type GrantRole = CaseRole | ClientRole;
/** One live grant per principal, case and slot: viewer and editor share the content slot, so a change replaces it. */
export type GrantSlot = 'content' | 'operator' | 'publisher' | 'grant-admin';
export type CaseCapability = 'operate' | 'publish';
export type GrantState = 'pending' | 'active' | 'revoked';
export type GrantScope = { kind: 'case'; caseId: CaseId } | { kind: 'client' };

export interface GrantRecord {
  readonly grantId: string;
  readonly clientId: ClientId;
  readonly scope: GrantScope;
  readonly issuer: string;
  readonly subject: string;
  readonly principalKind: Principal['kind'];
  readonly role: GrantRole;
  readonly state: GrantState;
  /** ISO instant after which the grant is void; null never expires. */
  readonly expiresAt: string | null;
  readonly version: number;
  /** The management operation that created this grant, and the canonical request it carried. */
  readonly createdOperationId: string;
  readonly request: string;
  readonly createdBy: { issuer: string; subject: string };
  readonly createdAt: string;
  /** The grant this one replaced (an update), or null. */
  readonly supersedes: string | null;
  readonly revokedOperationId: string | null;
  readonly revokedAt: string | null;
}
export type PrincipalKey = { issuer: string; subject: string };
export type NewGrant = Omit<GrantRecord, 'state' | 'version' | 'revokedOperationId' | 'revokedAt'>;

/** Who performed a management operation: a verified principal, or the trusted control plane (bootstrap only). */
export type OperationActor = { issuer: string; subject: string; kind: Principal['kind'] | 'control-plane' };
export type OperationType = 'create' | 'update' | 'revoke' | 'bootstrap';
/**
 * The ledger row of one management operation. It is bound to its client, actor, type and canonical request, and it fixes
 * the audit event (canonical JSON and SHA-256 digest) the operation must persist. `recorded` means that event is not yet
 * confirmed persisted; `audited` means it is, and the operation never appends again.
 */
export interface GrantOperation {
  readonly operationId: string;
  readonly operation: OperationType;
  readonly actor: OperationActor;
  readonly request: string;
  readonly grantId: string;
  readonly event: string;
  readonly eventDigest: string;
  readonly state: 'recorded' | 'audited';
  readonly recordedAt: string;
}
export type NewOperation = Omit<GrantOperation, 'state'>;

/**
 * The grant store of one client instance. Every method is scoped by clientId; a row of another client never answers.
 * Writes are compare-and-set on the grant version and keyed by the management operation id.
 */
export interface GrantRepository {
  /** Active and pending grants of one principal for one case or for the client; the caller decides what counts. */
  grantsOf(a: { clientId: ClientId; principal: PrincipalKey; scope: GrantScope }): Promise<readonly GrantRecord[]>;
  get(a: { clientId: ClientId; grantId: string }): Promise<GrantRecord | null>;
  /** The ledger row of an operation id, whatever its type or actor; the caller compares them. */
  operationOf(a: { clientId: ClientId; operationId: string }): Promise<GrantOperation | null>;
  /**
   * Inserts a pending grant and its operation row in one batch, unless a live grant holds its slot or the operation id is
   * used (null). A storage failure rejects; it is never reported as a lost race.
   */
  insertPending(a: { grant: NewGrant; operation: NewOperation }): Promise<GrantRecord | null>;
  /** Revokes the active grant at expectedVersion and, in the same batch, inserts its pending replacement and the operation row. */
  supersede(a: { clientId: ClientId; grantId: string; expectedVersion: number; replacement: NewGrant; operation: NewOperation; at: string }): Promise<GrantRecord | null>;
  /** Moves a pending grant to active; returns the active row, or null when it is no longer pending. */
  activate(a: { clientId: ClientId; grantId: string; version: number }): Promise<GrantRecord | null>;
  /** Revokes a pending or active grant at expectedVersion and records the operation in one batch; null when the CAS lost. */
  revoke(a: { clientId: ClientId; grantId: string; expectedVersion: number; operation: NewOperation; at: string }): Promise<GrantRecord | null>;
  /** Marks the operation's audit event as confirmed persisted; true when the row is now `audited`. */
  settle(a: { clientId: ClientId; operationId: string }): Promise<boolean>;
}

/** Whether a case exists in this client instance, before or after any publication. Owned by storage (GRS-115). */
export interface CaseDirectory { exists(a: { clientId: ClientId; caseId: CaseId }): Promise<boolean> }

export const CASE_ROLES: readonly CaseRole[] = ['viewer', 'editor', 'operator', 'publisher'];
export const GRANT_ROLES: readonly GrantRole[] = [...CASE_ROLES, 'grant-admin'];
export const slotOf = (role: GrantRole): GrantSlot => (role === 'viewer' || role === 'editor' ? 'content' : role);
const OPERATIONS: Record<GrantRole, readonly CaseOperation[]> = {
  viewer: ['read', 'read-original', 'read-preview'],
  editor: ['read', 'read-original', 'read-preview', 'write-user-work'],
  operator: [],
  publisher: [],
  'grant-admin': [],
};
const CAPABILITIES: Record<GrantRole, readonly CaseCapability[]> = { viewer: [], editor: [], operator: ['operate'], publisher: ['publish'], 'grant-admin': [] };
export const permits = (role: GrantRole, operation: CaseOperation) => OPERATIONS[role]?.includes(operation) === true;
export const enables = (role: GrantRole, capability: CaseCapability) => CAPABILITIES[role]?.includes(capability) === true;

/** A grant counts only when active, unexpired, and exactly this client's, principal's and scope's. */
export function effective(g: GrantRecord, a: { clientId: ClientId; principal: Principal; scope: GrantScope; now: Date }): boolean {
  if (g.state !== 'active' || g.clientId !== a.clientId || g.issuer !== a.principal.issuer || g.subject !== a.principal.subject || g.principalKind !== a.principal.kind) return false;
  if (g.scope.kind !== a.scope.kind || (g.scope.kind === 'case' && a.scope.kind === 'case' && g.scope.caseId !== a.scope.caseId)) return false;
  if (g.expiresAt === null) return true;
  const until = Date.parse(g.expiresAt);
  return Number.isFinite(until) && until > a.now.getTime();
}
