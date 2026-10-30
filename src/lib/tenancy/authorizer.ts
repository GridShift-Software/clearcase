import type { AuditEvent, AuditSink, CaseId, CaseOperation, IdentityState, Principal, SessionId } from '../server/runtime/contracts.ts';
import { codeOf, contractError } from '../server/runtime/errors.ts';
import { effective, enables, permits, type CaseCapability, type CaseDirectory, type GrantRecord, type GrantRepository } from './grants.ts';
import type { ClientResourceIdentity } from './manifest.ts';

/**
 * The callback the identity provider (GRS-113) calls once it has verified a principal and session. Frozen shape:
 * principal and sessionId are that provider's verified values; the client is the deployment's, never the request's.
 * Resolves when allowed; otherwise throws a ContractError: unauthenticated, wrong-client, forbidden,
 * identity-unavailable (grant or case lookup failed) or audit-unavailable (a required access event did not persist).
 */
export type AuthorizeCase = (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; operation: CaseOperation }) => Promise<void>;
export type AuthorizeCapability = (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; capability: CaseCapability }) => Promise<void>;
/** AuthorizeCase over a list: resolves to the cases allowed, once every one of them is recorded; refuses as it does. */
export type AuthorizeCases = (a: { principal: Principal; sessionId: SessionId; operation: CaseOperation; caseIds: readonly CaseId[] | Promise<readonly CaseId[]> }) => Promise<ReadonlySet<CaseId>>;

export interface CaseAuthorizerOptions {
  /** The validated resource identity of this deployment (resolveDeployment), from trusted deployment configuration. */
  deployment: ClientResourceIdentity;
  grants: GrantRepository;
  cases: CaseDirectory;
  /** `appendAll`, when given, stores every event or none, and resolves only once all are stored. */
  audit: AuditSink & { appendAll?(events: readonly AuditEvent[]): Promise<void> };
  now: () => Date;
  lookup?: (a: { principal: Principal; caseId: CaseId }) => Promise<{ grants: readonly GrantRecord[]; exists: boolean }>;
  /** Every case grant of a principal and which of their cases exist (principalCaseGrants), so a list is decided in one read. */
  caseGrants?: (principal: Principal) => Promise<{ grants: readonly GrantRecord[]; present: ReadonlySet<string> }>;
  readAudit?: (event: import('../server/runtime/contracts.ts').AuditEvent) => void;
  newEventId?: () => string;
}

const OPERATIONS = new Set<CaseOperation>(['read', 'read-original', 'read-preview', 'write-user-work']);
const CAPABILITIES = new Set<CaseCapability>(['operate', 'publish']);
const CASE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unavailable = () => contractError('identity-unavailable', true);

/** A principal belongs to this deployment only through its kind's own issuer: the client's application or staff's. */
export function belongs(deployment: ClientResourceIdentity, principal: Principal): boolean {
  return principal.kind === 'client' ? principal.issuer === deployment.clientIssuer : principal.kind === 'staff' && principal.issuer === deployment.staffIssuer;
}

/**
 * Case authorization from explicit grants only. Client membership, a management role or staff membership grant no case
 * content. Every allowed access, client or staff, appends a `succeeded` event with the verified actor, and is allowed only
 * once that append is acknowledged: with the log unavailable no case is reachable (audit-unavailable). Every denial of a
 * verified principal appends a best-effort `denied` event; the refusal stands whether or not it persists.
 *
 * A denial event is scoped to the case (object.caseId) only when the principal holds an effective grant on a case that
 * exists, so a caller can neither plant events in a case's audit scope nor tell an unknown case from a case it has no
 * grant on. object.id carries the requested id only when it is a well-formed id. A missing grant and an unknown case refuse
 * identically.
 */
export function createCaseAuthorizer(o: CaseAuthorizerOptions): { authorizeCase: AuthorizeCase; authorizeCapability: AuthorizeCapability; authorizeCases: AuthorizeCases } {
  if (typeof o?.audit?.append !== 'function' || typeof o.grants?.grantsOf !== 'function' || typeof o.cases?.exists !== 'function') throw new TypeError('the case authorizer needs a grant store, a case directory and an audit sink');
  const { deployment } = o, clientId = deployment.clientId, eventId = o.newEventId ?? (() => crypto.randomUUID());
  const actor = (principal: Principal | null, sessionId: SessionId | null): IdentityState =>
    principal && sessionId ? { kind: 'verified', principal: { issuer: principal.issuer, subject: principal.subject, kind: principal.kind }, sessionId } : { kind: 'anonymous', principal: null, sessionId: null };
  const event = (who: IdentityState, action: string, objectId: string, scoped: CaseId | null, outcome: 'succeeded' | 'denied') =>
    o.audit.append({ eventId: eventId(), actor: who, action, object: { kind: 'case', id: objectId, caseId: scoped }, version: null, outcome, at: o.now().toISOString() });

  async function check(a: { principal: Principal; sessionId: SessionId; caseId: CaseId }, allowed: (g: GrantRecord) => boolean, action: string) {
    const principal = a?.principal ?? null, sessionId = a?.sessionId ?? null, who = actor(principal, sessionId);
    const objectId = typeof a?.caseId === 'string' && CASE_LABEL.test(a.caseId) ? a.caseId : 'invalid';
    const deny = async (code: 'unauthenticated' | 'wrong-client' | 'forbidden', scoped: CaseId | null = null) => {
      // The refusal stands whether or not its event persists.
      if (code !== 'unauthenticated') await event(who, action, objectId, scoped, 'denied').catch(() => undefined);
      throw contractError(code);
    };
    if (!principal || !sessionId || typeof principal.issuer !== 'string' || typeof principal.subject !== 'string' || !principal.subject) return deny('unauthenticated');
    if (!belongs(deployment, principal)) return deny('wrong-client');
    if (typeof a.caseId !== 'string' || !a.caseId) return deny('forbidden');
    const scope = { kind: 'case', caseId: a.caseId } as const, now = o.now();
    const joined = o.lookup ? await o.lookup(a) : null;
    const rows = joined ? joined.grants : await o.grants.grantsOf({ clientId, principal: { issuer: principal.issuer, subject: principal.subject }, scope }).catch(() => { throw unavailable(); });
    const held = rows.filter((g) => effective(g, { clientId, principal, scope, now }));
    const exists = async () => joined ? joined.exists : (await o.cases.exists({ clientId, caseId: a.caseId }).catch(() => undefined)) === true;
    if (!held.some(allowed)) return deny('forbidden', held.length > 0 && (await exists()) ? a.caseId : null);
    const known = joined ? joined.exists : await o.cases.exists({ clientId, caseId: a.caseId }).catch(() => { throw unavailable(); });
    if (known !== true) return deny('forbidden');
    if (o.readAudit && ['case.read', 'case.read-original', 'case.read-preview'].includes(action)) {
      o.readAudit({ eventId: eventId(), actor: who, action, object: { kind: 'case', id: objectId, caseId: a.caseId }, version: null, outcome: 'succeeded', at: o.now().toISOString() });
      return;
    }
    await event(who, action, objectId, a.caseId, 'succeeded').catch(() => { throw contractError('audit-unavailable', true); });
  }

  const appendAll = (events: AuditEvent[]) => !events.length ? Promise.resolve()
    : o.audit.appendAll ? o.audit.appendAll(events) : Promise.all(events.map((e) => o.audit.append(e))).then(() => undefined);

  /**
   * check()'s rules for each case of a list, in its order, from one grant read: the first refusal that is not `forbidden`
   * refuses the list, as a loop of checks would. A listed case is returned only once its `succeeded` event is stored,
   * all in one append; the denials go in another, best-effort, as check()'s do.
   */
  async function checkAll(a: Parameters<AuthorizeCases>[0], allowed: (g: GrantRecord) => boolean, action: string): Promise<ReadonlySet<CaseId>> {
    if (!o.caseGrants) {
      const ids = await a.caseIds;
      const listed = await Promise.all(ids.map((caseId) => check({ ...a, caseId }, allowed, action).then(() => true, (e) => { if (codeOf(e) === 'forbidden') return false; throw e; })));
      return new Set(ids.filter((_, i) => listed[i]));
    }
    const principal = a?.principal ?? null, sessionId = a?.sessionId ?? null, who = actor(principal, sessionId);
    const verified = !!principal && !!sessionId && typeof principal.issuer === 'string' && typeof principal.subject === 'string' && !!principal.subject;
    const [ids, read] = await Promise.all([a.caseIds, verified && belongs(deployment, principal) ? o.caseGrants(principal).catch(() => { throw unavailable(); }) : null]);
    const now = o.now(), granted = new Set<CaseId>(), reads: AuditEvent[] = [], denials: AuditEvent[] = [];
    const record = (objectId: string, scoped: CaseId | null, outcome: 'succeeded' | 'denied'): AuditEvent =>
      ({ eventId: eventId(), actor: who, action, object: { kind: 'case', id: objectId, caseId: scoped }, version: null, outcome, at: now.toISOString() });
    for (const caseId of ids) {
      const objectId = typeof caseId === 'string' && CASE_LABEL.test(caseId) ? caseId : 'invalid';
      if (!verified) throw contractError('unauthenticated');
      if (!read) { await appendAll([record(objectId, null, 'denied')]).catch(() => undefined); throw contractError('wrong-client'); }
      if (typeof caseId !== 'string' || !caseId) { denials.push(record(objectId, null, 'denied')); continue; }
      const held = read.grants.filter((g) => effective(g, { clientId, principal: principal!, scope: { kind: 'case', caseId }, now }));
      const exists = read.present.has(caseId);
      if (!held.some(allowed)) denials.push(record(objectId, held.length > 0 && exists ? caseId : null, 'denied'));
      else if (!exists) denials.push(record(objectId, null, 'denied'));
      else { granted.add(caseId); reads.push(record(objectId, caseId, 'succeeded')); }
    }
    await Promise.all([
      appendAll(denials).catch(() => undefined),
      appendAll(reads).catch(() => { throw contractError('audit-unavailable', true); }),
    ]);
    return granted;
  }

  return {
    authorizeCases: (a) => checkAll(a, (g) => OPERATIONS.has(a.operation) && permits(g.role, a.operation), `case.${OPERATIONS.has(a?.operation) ? a.operation : 'unknown'}`),
    authorizeCase: (a) => check(a, (g) => OPERATIONS.has(a.operation) && permits(g.role, a.operation), `case.${OPERATIONS.has(a?.operation) ? a.operation : 'unknown'}`),
    authorizeCapability: (a) => check(a, (g) => CAPABILITIES.has(a.capability) && enables(g.role, a.capability), `case.${CAPABILITIES.has(a?.capability) ? a.capability : 'unknown'}`),
  };
}
