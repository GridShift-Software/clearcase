// Contract diagnostics only. No production entry imports this module or accepts these session handles.
import type * as C from './contracts.ts';
import { id } from './ids.ts';
import { contractError } from './errors.ts';
import { createMemoryReader } from './memory-reader.ts';
import { createMemoryAssets } from './memory-assets.ts';
import { createMemoryWork, newWork } from './memory-work.ts';
import type { WorkState } from './memory-work.ts';

export interface MemoryVersion { info: C.VersionInfo; files: { path: string; bytes: Uint8Array }[]; rows: C.DocumentRow[]; seeds: C.SeedRow[] }
export interface MemoryAsset { ref: C.AssetRef; bytes: Uint8Array; metadata: C.AssetMetadata }
export interface MemoryClient { clientId: C.ClientId; issuer: string; cases: C.CaseInfo[]; versions: MemoryVersion[]; assets: MemoryAsset[] }
export interface MemorySession { sessionId: C.SessionId; clientId: C.ClientId; subject: string; kind: 'client' | 'staff'; expiresAt: string; grants: { caseId: C.CaseId; role: 'viewer' | 'editor' }[] }
export interface MemoryFixture { clients: MemoryClient[]; identities: MemorySession[]; revision: string; sha256: C.Sha256 }
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
  work(caseId: C.CaseId): WorkState;
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
    const principal: C.Principal | null = session ? { issuer: fixture.clients.find((c) => c.clientId === session.clientId)!.issuer, subject: session.subject, kind: session.kind } : null;
    async function checkRevocation() {
      await before('identity');
      if (sessionId === null) throw contractError('unauthenticated');
      if (!session || revoked.has(sessionId) || Date.parse(session.expiresAt) <= a.now().getTime()) throw contractError('invalid-session');
      if (session.clientId !== client!.clientId) throw contractError('wrong-client');
    }
    const methods = { clientId: clientId, checkRevocation, async authorize(scope: C.Scope & { operation: C.CaseOperation }) {
      await checkRevocation();
      const grant = session?.grants.find((g) => g.caseId === scope.caseId);
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
    };
    const store = createMemoryReader(ctx);
    const assets = createMemoryAssets(ctx, (asset) => assetFaults.get(JSON.stringify([clientId, asset])) ?? null);
    return { identity, store, assets, userWork: createMemoryWork(ctx, store),
      audit: { async append(event) { await before('audit'); await identity.checkRevocation(); ctx.audit(event); return { eventId: event.eventId }; } },
      runtime: { build: Object.freeze({ revision: fixture.revision, dirty: true, exported: false, builtAt: a.now().toISOString(), bun: '1.4.2', buildId: 'memory-contract-diagnostic', target: 'cloudflare', profile: 'hosted-gate' }), gate: { runId: 'memory-contract-diagnostic', fixtureSha256: fixture.sha256 }, now: ctx.now, async probe() { await before('probe'); throw contractError('missing-binding'); } },
    };
  }
  return { request, fail(value: MemoryFault) { fault = value; }, revoke(sessionId: C.SessionId) { revoked.add(sessionId); },
    publish(input: { clientId: C.ClientId; caseId: C.CaseId; publication: C.Publication }) {
      const c = fixture.clients.find((c) => c.clientId === input.clientId)?.cases.find((c) => c.caseId === input.caseId);
      if (!c) throw contractError('not-found'); c.publication = structuredClone(input.publication);
    },
    assetFault(input: { clientId: C.ClientId; asset: C.AssetRef; kind: 'missing' | 'changed' }) { assetFaults.set(JSON.stringify([input.clientId, input.asset]), input.kind); },
    events(clientId: C.ClientId) { return structuredClone(states.get(clientId)?.events ?? []); },
  };
}
