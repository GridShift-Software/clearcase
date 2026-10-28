// Contract diagnostics only. No production entry imports this module or accepts these session handles.
import type * as C from './contracts.ts';
import { id } from './ids.ts';
import { contractError, isDenial } from './errors.ts';
import { createMemoryReader } from './memory-reader.ts';
import { createMemoryAssets } from './memory-assets.ts';
import { createMemoryWork, newWork } from './memory-work.ts';
import { createMemoryShards } from './memory-shards.ts';
import type { WorkState } from './memory-work.ts';

export interface MemoryVersion { info: C.VersionInfo; files: { path: string; bytes: Uint8Array }[]; rows: C.DocumentRow[]; seeds: C.SeedRow[] }
export interface MemoryAsset { ref: C.AssetRef; bytes: Uint8Array; metadata: C.AssetMetadata }
export interface MemoryClient { clientId: C.ClientId; issuer: string; cases: C.CaseInfo[]; versions: MemoryVersion[]; assets: MemoryAsset[] }
// A session says who signed in; it carries no authority. Membership of a client and each case grant are separate,
// current state that every protected call reads again, so withdrawing either binds a live session at once.
export interface MemorySession { sessionId: C.SessionId; clientId: C.ClientId; subject: string; kind: 'client' | 'staff'; expiresAt: string }
export interface MemoryMembership { clientId: C.ClientId; subject: string }
export interface MemoryGrant { clientId: C.ClientId; subject: string; caseId: C.CaseId; role: 'viewer' | 'editor' }
export interface MemoryFixture { clients: MemoryClient[]; identities: MemorySession[]; memberships: MemoryMembership[]; grants: MemoryGrant[]; revision: string; sha256: C.Sha256 }
export type MemoryFault = 'identity' | 'storage' | 'audit' | 'snapshot' | null;
export interface MemoryState {
  work: Map<C.CaseId, WorkState>;
  definitions: Map<string, C.UserWorkTable>;
  snapshots: Map<string, { caseId: C.CaseId; revision: C.CaseRevision; snapshot: C.UserWorkExport }>;
  events: C.AuditEvent[];
}
export interface MemoryContext {
  client: MemoryClient; identity: C.Identity; state: MemoryState; now(): Date;
  before(operation: string): Promise<void>;
  audit(event: C.AuditEvent): void;
  /** Appends a server-built event for this request's actor; throws audit-unavailable when it cannot be persisted. */
  record(a: Pick<C.AuditEvent, 'action' | 'object' | 'version' | 'outcome'>): void;
  /** authorize(), appending a scoped denial event when it refuses; the refusal stands whether or not the append works. */
  authorized(scope: C.Scope, operation: C.CaseOperation, action: string, version?: C.ResultsVersion | null): Promise<void>;
  work(caseId: C.CaseId): WorkState;
}
export { isDenial } from './errors.ts';
// Each handle method works on its own copy of its arguments, so a caller that changes an argument while the call awaits
// changes nothing the call authorized, read or wrote. Provider registrations keep their own functions.
function detached<T extends object>(handle: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(handle)) {
    if (key === 'providers' || value === null || typeof value !== 'object' && typeof value !== 'function') out[key] = value;
    else if (typeof value === 'function') out[key] = (...args: unknown[]) => {
      const result: unknown = value.apply(handle, structuredClone(args));
      return result !== null && typeof result === 'object' && !(result instanceof Promise) ? detached(result) : result;
    };
    else out[key] = detached(value);
  }
  return out as T;
}
export function createMemoryBackend(a: { fixture: MemoryFixture; now: () => Date; before?: (operation: string) => Promise<void> }) {
  const fixture = structuredClone(a.fixture), revoked = new Set<C.SessionId>();
  const states = new Map<C.ClientId, MemoryState>();
  const assetFaults = new Map<string, 'missing' | 'changed'>();
  let fault: MemoryFault = null;
  const before = async (operation: string) => {
    await a.before?.(operation);
    if (fault === 'identity') throw contractError('identity-unavailable', true);
    if (fault === 'storage') throw contractError('storage-unavailable', true);
    if (fault === 'snapshot' && operation === 'snapshot') throw contractError('snapshot-failed', true);
  };
  function request(input: { clientId: C.ClientId; sessionId: C.SessionId | null }): C.RequestServices {
    // Copied once: the caller keeps its object, and nothing it changes later reaches this request's authority.
    const { clientId, sessionId } = { clientId: input.clientId, sessionId: input.sessionId };
    const client = fixture.clients.find((c) => c.clientId === clientId);
    if (!client) throw contractError('wrong-client');
    let state = states.get(clientId);
    if (!state) { state = { work: new Map(), definitions: new Map(), snapshots: new Map(), events: [] }; states.set(clientId, state); }
    const session = fixture.identities.find((s) => s.sessionId === sessionId);
    // Verified only while the session stands: a revoked, expired or other-client session is not who it names.
    const standing = !!session && !revoked.has(session.sessionId) && Date.parse(session.expiresAt) > a.now().getTime() && session.clientId === clientId;
    const principal: C.Principal | null = session && standing ? { issuer: fixture.clients.find((c) => c.clientId === session.clientId)!.issuer, subject: session.subject, kind: session.kind } : null;
    async function checkRevocation() {
      await before('identity');
      if (sessionId === null) throw contractError('unauthenticated');
      if (!session || revoked.has(sessionId) || Date.parse(session.expiresAt) <= a.now().getTime()) throw contractError('invalid-session');
      if (session.clientId !== client!.clientId) throw contractError('wrong-client');
      if (!fixture.memberships.some((m) => m.clientId === clientId && m.subject === session.subject)) throw contractError('forbidden');
    }
    const methods = { clientId, checkRevocation, async authorize(scope: C.Scope & { operation: C.CaseOperation }) {
      await checkRevocation();
      const grant = fixture.grants.find((g) => g.clientId === clientId && g.subject === session?.subject && g.caseId === scope.caseId);
      if (!grant || !client!.cases.some((c) => c.caseId === scope.caseId) || (scope.operation === 'write-user-work' && grant.role !== 'editor')) throw contractError('forbidden');
    } };
    const identity: C.Identity = principal && session ? { ...methods, kind: 'verified', principal, sessionId: session.sessionId } : { ...methods, kind: 'anonymous', principal: null, sessionId: null };
    const ctx: MemoryContext = { client, identity, state, before, now: () => new Date(a.now()),
      work(caseId) { let w = this.state.work.get(caseId); if (!w) { w = newWork(); this.state.work.set(caseId, w); } return w; },
      audit(event) {
        if (fault === 'audit') throw contractError('audit-unavailable', true);
        if (!event.eventId || !/^[a-z][a-z0-9.-]{0,63}$/.test(event.action) || !event.object.kind || !event.object.id || (!Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at) || JSON.stringify(event.actor) !== JSON.stringify(identity.kind === 'verified' ? { kind: identity.kind, principal: identity.principal, sessionId: identity.sessionId } : { kind: identity.kind, principal: null, sessionId: null })) throw contractError('invalid-event');
        const previous = this.state.events.find((e) => e.eventId === event.eventId);
        if (previous) { if (JSON.stringify(previous) !== JSON.stringify(event)) throw contractError('invalid-event'); return; }
        this.state.events.push(structuredClone(event));
      },
      record(a) {
        const actor: C.IdentityState = identity.kind === 'verified' ? { kind: 'verified', principal: identity.principal, sessionId: identity.sessionId } : { kind: 'anonymous', principal: null, sessionId: null };
        this.audit({ eventId: crypto.randomUUID(), actor, ...a, at: this.now().toISOString() });
      },
      async authorized(scope, operation, action, version = null) {
        try { await identity.authorize({ caseId: scope.caseId, operation }); }
        catch (e) {
          if (isDenial(e)) try { this.record({ action, object: { kind: 'case', id: scope.caseId, caseId: scope.caseId }, version, outcome: 'denied' }); } catch { /* the refusal stands */ }
          throw e;
        }
      },
    };
    const store = createMemoryReader(ctx);
    const assets = createMemoryAssets(ctx, (asset) => assetFaults.get(JSON.stringify([clientId, asset])) ?? null);
    return { identity, store: detached(store), assets: detached(assets), userWork: detached(createMemoryWork(ctx, store)), shards: createMemoryShards({ clientId }),
      audit: { async append(event) { event = structuredClone(event); await before('audit'); await identity.checkRevocation(); ctx.audit(event); return { eventId: event.eventId }; } },
      runtime: { build: Object.freeze({ revision: fixture.revision, dirty: true, exported: false, builtAt: a.now().toISOString(), bun: '1.4.2', buildId: 'memory-contract-diagnostic', target: 'cloudflare', profile: 'hosted-gate' }), gate: { runId: 'memory-contract-diagnostic', fixtureSha256: fixture.sha256 }, testIdentity: null, now: ctx.now, async probe() { await before('probe'); throw contractError('missing-binding'); } },
    };
  }
  return { request, fail(value: MemoryFault) { fault = value; }, revoke(sessionId: C.SessionId) { revoked.add(sessionId); },
    /** Sets (role) or withdraws (null) one subject's grant on one case. */
    grant(input: { clientId: C.ClientId; subject: string; caseId: C.CaseId; role: MemoryGrant['role'] | null }) {
      fixture.grants = fixture.grants.filter((g) => !(g.clientId === input.clientId && g.subject === input.subject && g.caseId === input.caseId));
      if (input.role) fixture.grants.push({ clientId: input.clientId, subject: input.subject, caseId: input.caseId, role: input.role });
    },
    membership(input: { clientId: C.ClientId; subject: string; member: boolean }) {
      fixture.memberships = fixture.memberships.filter((m) => !(m.clientId === input.clientId && m.subject === input.subject));
      if (input.member) fixture.memberships.push({ clientId: input.clientId, subject: input.subject });
    },
    publish(input: { clientId: C.ClientId; caseId: C.CaseId; publication: C.Publication }) {
      const c = fixture.clients.find((c) => c.clientId === input.clientId)?.cases.find((c) => c.caseId === input.caseId);
      if (!c) throw contractError('not-found'); c.publication = structuredClone(input.publication);
    },
    assetFault(input: { clientId: C.ClientId; asset: C.AssetRef; kind: 'missing' | 'changed' }) { assetFaults.set(JSON.stringify([input.clientId, input.asset]), input.kind); },
    events(clientId: C.ClientId) { return structuredClone(states.get(clientId)?.events ?? []); },
  };
}
