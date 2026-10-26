import type { AuditEvent, CaseId } from '../../server/runtime/contracts.ts';
import { codeOf, isDenial } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { canonicalJson } from '../../case-package/canonical.ts';
import { sha256Canonical } from '../../results-review/native/digest.ts';
import type { PublicationRequest } from './controller.ts';
import type { CandidateSnapshot, NativePublicationPorts, SignoffIdentity, SignoffRecord } from './ports.ts';
import { checkSnapshot, newWarnings, signoffBlocker, type Blocker } from './rules.ts';
import type { ReadinessFence, ReadinessFenceResult } from './readiness-fence.ts';

/** Own read-only contract; ordinary publication ports alone must remain unavailable. */
export type PublicationReadinessPorts = NativePublicationPorts & { readonly readinessFence?: ReadinessFence | null };

/** Observations only. Never a signed decision, pointer, apply receipt, or substitute for controller validation. */
export interface ReadinessView {
  caseId: string;
  identity: SignoffIdentity;
  materialSha256: string;
  blocker: Blocker | null;
  requiredAcknowledgements: string[];
  selfApprovalRequired: boolean;
  signoff: null | {
    signoffId: string;
    identity: SignoffIdentity;
    state: 'recorded' | 'audited';
    invalidated: boolean;
    blockers: ('signoff-not-effective' | 'signoff-stale')[];
  };
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNOFF = /^so-[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
class Refusal {
  readonly status: number; readonly code: string; readonly message: string;
  constructor(status: number, code: string, message: string) { this.status = status; this.code = code; this.message = message; }
}
const refuse = (status: number, code: string, message: string): never => { throw new Refusal(status, code, message); };
const unavailable = (): never => refuse(503, 'readiness-unavailable', 'Exact publication material is unavailable. No approval or publication is implied.');
const identityOf = (s: CandidateSnapshot): SignoffIdentity => ({
  candidateId: s.link.candidate.candidateId, linkId: s.link.linkId,
  submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
  resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256,
  packageInputRevisionId: s.link.candidate.packageInputRevisionId, diagnosticsSha256: s.validation.diagnosticsSha256,
  validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision,
});
const signedIdentity = (s: SignoffRecord): SignoffIdentity => ({
  candidateId: s.candidateId, linkId: s.linkId, submissionRevisionId: s.submissionRevisionId,
  submissionManifestSha256: s.submissionManifestSha256, resultsVersion: s.resultsVersion,
  manifestSha256: s.manifestSha256, packageInputRevisionId: s.packageInputRevisionId,
  diagnosticsSha256: s.diagnosticsSha256, validatorVersion: s.validatorVersion, snapshotRevision: s.snapshotRevision,
});

/** Own hook: parent must resolve the exact original Request to its real publication ports. No defaults/adapters here. */
export type ReadinessComposition = (a: { request: Request; platform: unknown }) => PublicationReadinessPorts | null | Promise<PublicationReadinessPorts | null>;
let composition: ReadinessComposition | null = null;
export function setReadinessComposition(c: ReadinessComposition | null): void { composition = c; }
export async function readinessControllerFor(a: { request: Request; platform: unknown }) {
  let ports: PublicationReadinessPorts | null = null;
  try { ports = await composition?.(a) ?? null; } catch { /* Fail closed. */ }
  return createPublicationReadiness(ports);
}

export function createPublicationReadiness(ports: PublicationReadinessPorts | null) {
  return { read: async (r: PublicationRequest): Promise<Response> => {
    try {
      if (r.request.method !== 'GET') refuse(405, 'method-not-allowed', 'Only GET is accepted.');
      if (!ports?.authorize || !ports.candidates || !ports.ledger || !ports.audit || !ports.publisher
        || ports.publisher.protocol !== 'atomic-publication/1' || typeof ports.publisher.receipt !== 'function' || typeof ports.now !== 'function'
        || ports.readinessFence?.protocol !== 'coherent-readiness/1' || typeof ports.readinessFence.check !== 'function') return unavailable();
      const p = ports;
      const raw = r.params.caseId;
      if (!raw || !PART.test(raw)) return refuse(404, 'not-found', 'Not found.');
      const caseId = id('case', raw) as CaseId;
      const who = r.identity;
      if (!who || who.kind !== 'verified') return refuse(401, 'unauthenticated', 'Sign in to continue.');
      if (who.clientId !== p.clientId) return refuse(401, 'wrong-client', 'Sign in for this client.');
      if (who.principal.kind !== 'staff') return refuse(403, 'forbidden', 'Explicit staff publication and preview access are required.');
      const scope = { clientId: p.clientId, caseId };
      const principal = Object.freeze({ ...who.principal }), sessionId = who.sessionId;
      const actor: AuditEvent['actor'] = Object.freeze({ kind: 'verified', principal, sessionId });
      const audit = async (outcome: AuditEvent['outcome'], action: string, candidateId: string) => {
        try { await p.audit!.append({ eventId: crypto.randomUUID(), actor, action, object: { kind: 'publication-readiness', id: candidateId, caseId }, version: null, outcome, at: p.now().toISOString() }); }
        catch { return refuse(503, 'audit-unavailable', 'Readiness was not released because its required audit could not be recorded.'); }
      };
      const denied = async (e: unknown): Promise<never> => {
        await audit('denied', 'publication.readiness.denied', raw);
        const code = codeOf(e);
        if (code === 'unauthenticated' || code === 'invalid-session' || code === 'wrong-client') return refuse(401, 'unauthenticated', 'Sign in for this client.');
        if (code === 'forbidden' || code === 'not-found') return refuse(403, 'forbidden', 'Explicit staff publication and preview access are required.');
        return refuse(503, 'identity-unavailable', 'Current authority cannot be verified.');
      };
      // The audited decision for both capabilities, made once at admission.
      const authority = async () => {
        try {
          await who.checkRevocation();
          await p.authorize!({ principal, sessionId, caseId, capability: 'publish' });
          await who.authorize({ caseId, operation: 'read-preview' });
        } catch (e) { return denied(e); }
      };
      // Later boundaries observe the live session only. Both grants are read again by the release fence, in the same
      // primary statement that compares the material and sign-off observations, after every other await.
      const session = async () => {
        try { await who.checkRevocation(); } catch (e) { return denied(e); }
      };
      // Both capabilities precede ALL snapshot/ledger/storage metadata, not just response release.
      await authority();
      const candidateId = r.url.searchParams.get('candidateId');
      const signoffId = r.url.searchParams.get('signoffId');
      if (!candidateId || !PART.test(candidateId) || (signoffId !== null && !SIGNOFF.test(signoffId))) return refuse(422, 'invalid-request', 'Name one candidate and optionally one exact sign-off.');
      await audit('succeeded', 'publication.readiness.intent', candidateId);
      await session();
      const snapshot = async () => {
        let rawSnapshot: unknown;
        // The reader audits its own failure. Its denial stands as one here; any other fault holds readiness unavailable.
        try { rawSnapshot = await p.candidates!.read({ ...scope, candidateId }); } catch (e) { return isDenial(e) ? denied(e) : unavailable(); }
        if (rawSnapshot === null) return refuse(404, 'not-found', 'Not found.');
        // Fail unavailable rather than truncate any acknowledgement/blocker set. Bound before checkSnapshot clones it.
        if (JSON.stringify(rawSnapshot).length > 256 * 1024) return unavailable();
        const s = checkSnapshot(rawSnapshot);
        if (!s) return unavailable();
        if (s.link.clientId !== p.clientId || s.link.caseId !== caseId || s.link.candidate.clientId !== p.clientId
          || s.link.candidate.caseId !== caseId || s.link.candidate.candidateId !== candidateId) return refuse(404, 'not-found', 'Not found.');
        if ([s.validation.errorFingerprints, s.validation.warningFingerprints, s.trustedBaseline, s.requiredSections, s.requiredPreviews].some((xs) => xs.length > 200)) return unavailable();
        return s;
      };
      const signoff = async () => {
        if (!signoffId) return null;
        const so = await p.ledger!.signoff({ ...scope, signoffId });
        if (!so || so.clientId !== p.clientId || so.caseId !== caseId || so.signoffId !== signoffId || so.candidateId !== candidateId) return refuse(404, 'not-found', 'Not found.');
        if (JSON.stringify(so).length > 256 * 1024 || !['recorded', 'audited'].includes(so.state)
          || so.warningFingerprints.length > 200 || so.acknowledgements.length > 200) return unavailable();
        return structuredClone(so);
      };
      const s = await snapshot(), so = await signoff();
      const signed = so ? canonicalJson(so) : null;
      const materialSha256 = await sha256Canonical(s);
      const blocker = signoffBlocker(s), requiredAcknowledgements = newWarnings(s);
      const blockers: NonNullable<ReadinessView['signoff']>['blockers'] = [];
      if (so) {
        if (so.state !== 'audited' || so.invalidatedAt !== null) blockers.push('signoff-not-effective');
        if (canonicalJson(signedIdentity(so)) !== canonicalJson(identityOf(s)) || blocker
          || canonicalJson(requiredAcknowledgements) !== canonicalJson(so.acknowledgements.map((x) => x.fingerprint))
          || canonicalJson([...s.validation.warningFingerprints].sort()) !== canonicalJson(so.warningFingerprints)) blockers.push('signoff-stale');
      }
      const view: ReadinessView = {
        caseId, identity: identityOf(s), materialSha256, blocker, requiredAcknowledgements,
        selfApprovalRequired: principal.issuer === s.preparedBy.issuer && principal.subject === s.preparedBy.subject,
        signoff: so ? { signoffId: so.signoffId, identity: signedIdentity(so), state: so.state, invalidated: so.invalidatedAt !== null, blockers } : null,
      };
      // This records intent, NOT successful disclosure. A later refusal must never leave a release-success event.
      await audit('succeeded', 'publication.readiness.release-intent', candidateId);
      await session();
      // Early sign-off change detection only. The material is read once: the fence below compares that observation's
      // generation, link, version, validation and baseline coherently, which a second full read could not.
      const latestSignoff = await signoff();
      const stale = async () => {
        await audit('refused', 'publication.readiness.refused', candidateId);
        return refuse(409, 'readiness-stale', 'The candidate or sign-off changed during the read. Refresh and review again.');
      };
      if ((latestSignoff ? canonicalJson(latestSignoff) : null) !== signed) return await stale();
      // ALL awaited audit/authority/storage/hash work precedes this shared D1 check. It compares the ORIGINAL
      // observations, not copies refreshed independently. Clerk was last observed in session(), not locked by D1.
      let fenced: ReadinessFenceResult;
      try {
        fenced = await p.readinessFence!.check({ ...scope, principal, sessionId, snapshot: s, signoff: so });
      } catch { fenced = 'unavailable'; }
      if (fenced === 'stale') return await stale();
      if (fenced !== 'current') {
        await audit(fenced === 'forbidden' || fenced === 'invalid-session' ? 'denied' : 'failed', 'publication.readiness.refused', candidateId);
        if (fenced === 'forbidden') return refuse(403, 'forbidden', 'Explicit staff publication and preview access are required.');
        if (fenced === 'invalid-session') return refuse(401, 'unauthenticated', 'Sign in for this client.');
        return unavailable();
      }
      // No further await, callback, audit or storage read on the successful release path.
      return json(200, view);
    } catch (e) {
      if (e instanceof Refusal) return json(e.status, { code: e.code, message: e.message });
      return json(503, { code: 'readiness-unavailable', message: 'Exact publication material cannot be read now. Nothing here approves or publishes it.' });
    }
  } };
}
