// The operator's evidence build for one candidate (real-export design 2; U14). POST /operator/publication/[caseId]/evidence with
// `{ candidateId, restart? }` runs one bounded build request (`evidence-gate.ts`) and answers where the run stands; the operator calls it
// again until it answers `complete`. `restart: true` begins the next generation, which is the supported way to replace a sealed run whose
// summary or items came from an older producer: readiness reads only the latest generation, so the older one is never served again.
// Nothing here signs off, publishes or decides readiness.
import type { AuditEvent, AuditSink, CaseId, ClientId, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { codeOf, isDenial } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { readAtMost } from '../../submissions/body.ts';

/** What one build request reports; the gate's own outcome type, restated here so this module stays free of server imports. */
export type EvidenceBuildState =
  | { readonly state: 'building'; readonly generation: string; readonly items: number; readonly planned: number }
  | { readonly state: 'rendering'; readonly generation: string; readonly remaining: number; readonly reason: string | null }
  | { readonly state: 'complete'; readonly generation: string; readonly root: string }
  | { readonly state: 'leased'; readonly generation: string }
  | { readonly state: 'refused'; readonly generation: string; readonly reason: string }
  | { readonly state: 'renderer-unavailable'; readonly generation: string };
export interface EvidenceBuildPort { step(a: { caseId: CaseId; candidateId: string; restart: boolean; leaseId: string }): Promise<EvidenceBuildState> }

export interface EvidenceBuildPorts {
  readonly clientId: ClientId;
  /** The audited operate admission (live session, then the explicit operate grant), as the import and the private preview use it. */
  readonly authorizeOperate: (a: { principal: Principal; sessionId: SessionId; clientId: ClientId; caseId: CaseId }) => Promise<void>;
  readonly builder: EvidenceBuildPort;
  readonly audit: AuditSink;
  now(): Date;
}
export interface EvidenceBuildRequest { request: Request; url: URL; params: Record<string, string>; identity: import('../../server/runtime/contracts.ts').Identity | null | undefined }

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY = 1024;
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
const STATUS: Record<EvidenceBuildState['state'], number> = { building: 202, rendering: 202, leased: 409, complete: 200, refused: 409, 'renderer-unavailable': 503 };

export function createEvidenceBuild(ports: EvidenceBuildPorts | null) {
  return { async step(r: EvidenceBuildRequest): Promise<Response> {
    if (r.request.method !== 'POST') return json(405, { code: 'method-not-allowed', message: 'Only POST is accepted.' });
    if (r.request.headers.get('origin') !== r.url.origin) return json(403, { code: 'cross-origin', message: 'Cross-origin writes are refused.' });
    if ((r.request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') return json(415, { code: 'unsupported-media-type', message: 'Send application/json.' });
    if (!ports || typeof ports.authorizeOperate !== 'function' || typeof ports.builder?.step !== 'function' || typeof ports.audit?.append !== 'function' || typeof ports.now !== 'function')
      return json(503, { code: 'evidence-unavailable', message: 'Publication evidence cannot be built here now.' });
    const raw = r.params.caseId;
    if (!raw || !PART.test(raw)) return json(404, { code: 'not-found', message: 'Not found.' });
    const caseId = id('case', raw) as CaseId, who = r.identity;
    if (!who || who.kind !== 'verified') return json(401, { code: 'unauthenticated', message: 'Sign in to continue.' });
    if (who.clientId !== ports.clientId) return json(401, { code: 'wrong-client', message: 'Sign in for this client.' });
    if (who.principal.kind !== 'staff') return json(403, { code: 'forbidden', message: 'Explicit staff operate access is required.' });
    const principal = who.principal, sessionId = who.sessionId;
    const actor: AuditEvent['actor'] = { kind: 'verified', principal, sessionId };
    const audit = async (outcome: AuditEvent['outcome'], candidateId: string, detail: string) => {
      const event: AuditEvent = { eventId: crypto.randomUUID(), actor, action: `publication.evidence.${detail}`, object: { kind: 'candidate', id: candidateId, caseId }, version: null, outcome, at: ports.now().toISOString() };
      return (await ports.audit.append(event)).eventId === event.eventId;
    };
    try { await ports.authorizeOperate({ principal, sessionId, clientId: ports.clientId, caseId }); }
    catch (e) {
      const code = codeOf(e);
      if (code === 'unauthenticated' || code === 'invalid-session' || code === 'wrong-client') return json(401, { code: 'unauthenticated', message: 'Sign in for this client.' });
      if (isDenial(e)) return json(403, { code: 'forbidden', message: 'Explicit staff operate access is required.' });
      return json(503, { code: 'identity-unavailable', message: 'Current authority cannot be verified.' });
    }
    const body = await readAtMost(r.request.body, MAX_BODY);
    if (body.kind !== 'ok') return json(body.kind === 'too-large' ? 413 : 400, { code: 'invalid-request', message: 'Send one small JSON object.' });
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.bytes)); } catch { value = null; }
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => k !== 'candidateId' && k !== 'restart')
      || typeof v.candidateId !== 'string' || !PART.test(v.candidateId) || (v.restart !== undefined && typeof v.restart !== 'boolean'))
      return json(422, { code: 'invalid-request', message: 'Name one candidate, and optionally restart: true.' });
    const candidateId = v.candidateId, restart = v.restart === true;
    try {
      if (!await audit('succeeded', candidateId, restart ? 'restart.intent' : 'step.intent')) return json(503, { code: 'audit-unavailable', message: 'The build was not started because its audit could not be recorded.' });
    } catch { return json(503, { code: 'audit-unavailable', message: 'The build was not started because its audit could not be recorded.' }); }
    let out: EvidenceBuildState;
    try { out = await ports.builder.step({ caseId, candidateId, restart, leaseId: `evidence-${crypto.randomUUID()}` }); }
    catch (e) {
      await audit('failed', candidateId, 'step').catch(() => false);
      if (codeOf(e) === 'integrity') return json(409, { code: 'material-changed', message: 'The candidate’s stored material does not verify. Nothing was written.' });
      return json(503, { code: 'evidence-unavailable', message: 'Publication evidence cannot be built now. Retry; nothing partial is served.' });
    }
    await audit(out.state === 'refused' ? 'refused' : 'succeeded', candidateId, `step.${out.state}`).catch(() => false);
    return json(STATUS[out.state], out);
  } };
}

/** Own hook: the parent resolves the exact original Request to its ports. Unset or null, every request answers 503. */
export type EvidenceBuildComposition = (a: { request: Request; platform: unknown }) => EvidenceBuildPorts | null | Promise<EvidenceBuildPorts | null>;
let composition: EvidenceBuildComposition | null = null;
export function setEvidenceBuildComposition(c: EvidenceBuildComposition | null): void { composition = c; }
export async function evidenceBuildControllerFor(a: { request: Request; platform: unknown }) {
  let ports: EvidenceBuildPorts | null = null;
  try { ports = await composition?.(a) ?? null; } catch { ports = null; }
  return createEvidenceBuild(ports);
}
