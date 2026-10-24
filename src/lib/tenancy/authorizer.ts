import type { AuditSink, CaseId, CaseOperation, IdentityState, Principal, SessionId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
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

export interface CaseAuthorizerOptions {
  /** The validated resource identity of this deployment (resolveDeployment), from trusted deployment configuration. */
  deployment: ClientResourceIdentity;
  grants: GrantRepository;
  cases: CaseDirectory;
  audit: AuditSink;
  now: () => Date;
  newEventId?: () => string;
}

const OPERATIONS = new Set<CaseOperation>(['read', 'read-original', 'read-preview', 'write-user-work']);
const CAPABILITIES = new Set<CaseCapability>(['operate', 'publish']);
const unavailable = () => contractError('identity-unavailable', true);

/** A principal belongs to this deployment only through its kind's own issuer: the client's application or staff's. */
export function belongs(deployment: ClientResourceIdentity, principal: Principal): boolean {
  return principal.kind === 'client' ? principal.issuer === deployment.clientIssuer : principal.kind === 'staff' && principal.issuer === deployment.staffIssuer;
}

/**
 * Case authorization from explicit grants only. Client membership, a management role or staff membership grant no
 * case content; staff reach a case through an explicit grant, and each staff access appends an audit event that must
 * persist. A missing grant and an unknown case refuse identically, so a refusal reveals no case metadata.
 */
export function createCaseAuthorizer(o: CaseAuthorizerOptions): { authorizeCase: AuthorizeCase; authorizeCapability: AuthorizeCapability } {
  const { deployment } = o, clientId = deployment.clientId, eventId = o.newEventId ?? (() => crypto.randomUUID());
  const actor = (principal: Principal | null, sessionId: SessionId | null): IdentityState =>
    principal && sessionId ? { kind: 'verified', principal: { issuer: principal.issuer, subject: principal.subject, kind: principal.kind }, sessionId } : { kind: 'anonymous', principal: null, sessionId: null };
  const event = (who: IdentityState, action: string, caseId: CaseId, outcome: 'succeeded' | 'denied') =>
    o.audit.append({ eventId: eventId(), actor: who, action, object: { kind: 'case', id: caseId, caseId }, version: null, outcome, at: o.now().toISOString() });

  async function check(a: { principal: Principal; sessionId: SessionId; caseId: CaseId }, allowed: (g: GrantRecord) => boolean, action: string) {
    const principal = a?.principal ?? null, sessionId = a?.sessionId ?? null, who = actor(principal, sessionId);
    const deny = async (code: 'unauthenticated' | 'wrong-client' | 'forbidden') => {
      // The refusal stands whether or not its event persists.
      if (code !== 'unauthenticated' && typeof a.caseId === 'string') await event(who, action, a.caseId, 'denied').catch(() => undefined);
      throw contractError(code);
    };
    if (!principal || !sessionId || typeof principal.issuer !== 'string' || typeof principal.subject !== 'string' || !principal.subject) return deny('unauthenticated');
    if (!belongs(deployment, principal)) return deny('wrong-client');
    if (typeof a.caseId !== 'string' || !a.caseId) return deny('forbidden');
    const scope = { kind: 'case', caseId: a.caseId } as const, now = o.now();
    const rows = await o.grants.grantsOf({ clientId, principal: { issuer: principal.issuer, subject: principal.subject }, scope }).catch(() => { throw unavailable(); });
    if (!rows.some((g) => effective(g, { clientId, principal, scope, now }) && allowed(g))) return deny('forbidden');
    const exists = await o.cases.exists({ clientId, caseId: a.caseId }).catch(() => { throw unavailable(); });
    if (exists !== true) return deny('forbidden');
    if (principal.kind === 'staff') await event(who, action, a.caseId, 'succeeded').catch(() => { throw contractError('audit-unavailable', true); });
  }

  return {
    authorizeCase: (a) => check(a, (g) => OPERATIONS.has(a.operation) && permits(g.role, a.operation), `case.${OPERATIONS.has(a?.operation) ? a.operation : 'unknown'}`),
    authorizeCapability: (a) => check(a, (g) => CAPABILITIES.has(a.capability) && enables(g.role, a.capability), `case.${CAPABILITIES.has(a?.capability) ? a.capability : 'unknown'}`),
  };
}
