import type { AuditEvent, CaseId, Identity, Principal, ResultsVersion, SessionId } from '../../server/runtime/contracts.ts';
import { codeOf } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { readAtMost } from '../../submissions/body.ts';
import { checkSnapshot, newWarnings, signoffBlocker, type Blocker } from './rules.ts';
import type { CandidateSnapshot, NativePublicationPorts, OperationRecord, PointerOutcome, PublicationIntent, PublicationState, SignoffAcknowledgement, SignoffIdentity, SignoffRecord } from './ports.ts';

/** What one publication request carries: the request, its URL, the route params and the request's identity (the existing contract). */
export interface PublicationRequest { request: Request; url: URL; params: Partial<Record<'caseId', string>>; identity: Identity }

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const SIGNOFF = /^so-[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const RV = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9a-f]{32}$/;
/** A fixed bound on one JSON request body; a sign-off is identity fields plus at most this many reasoned acknowledgements. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ACKS = 200;
const MAX_REASON = 1000;
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...(status === 503 ? { 'retry-after': '2' } : {}) } });
class Refusal { readonly response: Response; constructor(response: Response) { this.response = response; } }
const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): never => { throw new Refusal(json(status, { code, message, ...extra })); };
const unavailable = (code = 'publication-unavailable', message = 'Publication is not available on this deployment yet.') => refuse(503, code, message);

/** Canonical JSON (keys sorted at every depth), so equal requests digest equally whatever their key order. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join() === [...keys].sort().join();
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function authorityRefusal(e: unknown): never {
  const code = codeOf(e);
  if (code === 'unauthenticated' || code === 'invalid-session') refuse(401, 'unauthenticated', 'Sign in to continue.');
  if (code === 'wrong-client') refuse(401, 'wrong-client', 'This session belongs to another client. Sign in for this client.');
  // An unknown case, a case without the grant and a grant on another case refuse identically.
  if (code === 'forbidden' || code === 'not-found') refuse(403, 'forbidden', 'You cannot publish results for this case.');
  return refuse(503, 'identity-unavailable', 'Sign-in is unavailable. Try again shortly.');
}

const IDENTITY_KEYS = ['linkId', 'submissionRevisionId', 'submissionManifestSha256', 'resultsVersion', 'manifestSha256', 'packageInputRevisionId', 'diagnosticsSha256', 'validatorVersion', 'snapshotRevision'] as const;
function identityOf(s: CandidateSnapshot): SignoffIdentity {
  return {
    candidateId: s.link.candidate.candidateId, linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
    resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256, packageInputRevisionId: s.link.candidate.packageInputRevisionId,
    diagnosticsSha256: s.validation.diagnosticsSha256, validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision,
  };
}
const differing = (a: SignoffIdentity, b: SignoffIdentity) => (['candidateId', ...IDENTITY_KEYS] as const).filter((k) => a[k] !== b[k]);

function expectedOf(v: unknown): PublicationState | null {
  if (!plain(v)) return null;
  if (v.kind === 'none' && exactKeys(v, ['kind'])) return { kind: 'none' };
  if ((v.kind === 'published' || v.kind === 'withdrawn') && exactKeys(v, ['kind', 'resultsVersion']) && typeof v.resultsVersion === 'string' && RV.test(v.resultsVersion))
    return { kind: v.kind, resultsVersion: v.resultsVersion as ResultsVersion };
  return null;
}
const blockerResponse: Record<Blocker['code'], [number, string]> = {
  'validation-failed': [422, 'Validation errors block sign-off and can never be waived.'],
  'required-section': [422, 'A required section does not validate or display; it blocks sign-off.'],
  'preview-not-ready': [422, 'A required file preview has not rendered; it holds the whole update.'],
};

/**
 * The publication HTTP controller (ADR-0010). Every answer is a JSON Response. Order of checks, for every route: origin,
 * media type, composed ports, case id, verified session of this client, revocation, explicit `publish` authority; only
 * then the bounded body, the ledger, the candidate and the pointer. A refusal at any step reads nothing later.
 */
export function createNativePublication(ports: NativePublicationPorts | null) {
  async function admit(r: PublicationRequest) {
    // The hosted entry refuses a cross-origin write before routing; this controller refuses it again rather than rely on it.
    if (r.request.method !== 'POST') refuse(405, 'method-not-allowed', 'Only POST is accepted.');
    if (r.request.headers.get('origin') !== r.url.origin) refuse(403, 'cross-origin', 'Cross-origin writes are refused.');
    if ((r.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') refuse(415, 'unsupported-media-type', 'Send application/json.');
    if (!ports || !ports.authorize || !ports.candidates || !ports.publisher || ports.publisher.protocol !== 'atomic-publication/1' || typeof ports.publisher.receipt !== 'function' || !ports.ledger || !ports.audit || typeof ports.now !== 'function') return unavailable();
    const raw = r.params.caseId;
    if (!raw || !PART.test(raw)) refuse(404, 'not-found', 'Not found.');
    const caseId = id('case', raw!) as CaseId;
    const who = r.identity;
    if (!who || who.kind !== 'verified') return refuse(401, 'unauthenticated', 'Sign in to continue.');
    if (who.clientId !== ports.clientId) refuse(401, 'wrong-client', 'This session belongs to another client. Sign in for this client.');
    const principal: Principal = who.principal, sessionId: SessionId = who.sessionId;
    try {
      await who.checkRevocation();
      await ports.authorize({ principal, sessionId, caseId, capability: 'publish' });
    } catch (e) { authorityRefusal(e); }
    const body = await readAtMost(r.request.body, MAX_BODY_BYTES);
    if (body.kind === 'incomplete') refuse(400, 'incomplete-body', 'The request was interrupted. Send it again with the same operation id.');
    if (body.kind === 'too-large') refuse(413, 'too-large', 'The request is too large.');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((body as { bytes: Uint8Array }).bytes)); } catch { refuse(422, 'invalid-request', 'Send one JSON object.'); }
    if (!plain(value)) refuse(422, 'invalid-request', 'Send one JSON object.');
    const actor = { issuer: principal.issuer, subject: principal.subject, kind: principal.kind } as const;
    const p = ports as NativePublicationPorts & { [K in 'authorize' | 'candidates' | 'publisher' | 'ledger' | 'audit']: NonNullable<NativePublicationPorts[K]> };
    // Called again by the atomic adapter under its shared mutation boundary, never as a saved admission verdict.
    const recheckAuthority = async () => {
      try {
        await who.checkRevocation();
        await p.authorize({ principal, sessionId, caseId, capability: 'publish' });
      } catch (e) { authorityRefusal(e); }
    };
    return { caseId, principal, sessionId, actor, recheckAuthority, body: value as Record<string, unknown>, p, scope: { clientId: p.clientId, caseId } };
  }
  type Admitted = Awaited<ReturnType<typeof admit>>;
  const storage = <T>(work: Promise<T>): Promise<T> => work.catch((e) => {
    if (e instanceof Refusal) throw e;
    return refuse(503, 'storage-unavailable', 'Publication storage is unavailable. Retry with the same operation id.');
  });
  const handle = (work: () => Promise<Response>) => work().catch((e) => { if (e instanceof Refusal) return e.response; throw e; });

  /** Reads and checks the candidate snapshot; an unreadable or foreign snapshot is never trusted. */
  async function candidate(a: Admitted, candidateId: string): Promise<CandidateSnapshot | null> {
    let raw: unknown;
    try { raw = await a.p.candidates.read({ clientId: a.p.clientId, caseId: a.caseId, candidateId }); } catch { return refuse(503, 'candidate-unavailable', 'The candidate cannot be read now. Try again shortly.'); }
    if (raw === null) return null;
    const s = checkSnapshot(raw);
    if (!s) return refuse(503, 'candidate-unavailable', 'The candidate cannot be read now. Try again shortly.');
    // A candidate of another client, case or candidate id is not this one.
    if (s.link.clientId !== a.p.clientId || s.link.caseId !== a.caseId || s.link.candidate.clientId !== a.p.clientId || s.link.candidate.caseId !== a.caseId || s.link.candidate.candidateId !== candidateId) return null;
    return s;
  }

  async function auditEvent(a: Admitted, action: 'publication.signoff' | 'publication.publish' | 'publication.withdraw', objectId: string, version: ResultsVersion, at: string): Promise<AuditEvent> {
    const session = (await sha256Hex(a.sessionId)).slice(0, 12);
    const event: AuditEvent = {
      eventId: `${action.replace('.', '-')}-${objectId}-${session}`.slice(0, 128), actor: { kind: 'verified', principal: { ...a.actor }, sessionId: a.sessionId },
      action, object: { kind: 'publication', id: objectId, caseId: a.caseId }, version, outcome: 'succeeded', at,
    };
    return event;
  }
  async function audit(a: Admitted, event: AuditEvent) {
    try { await a.p.audit.append(event); } catch { refuse(503, 'audit-unavailable', 'The action is recorded but its audit event did not persist. Retry with the same operation id.'); }
  }

  /** Both early feedback and the adapter's serialized recheck use fresh sign-off/candidate facts. */
  async function effectiveSignoff(a: Admitted, signoffId: string, signed?: SignoffIdentity): Promise<SignoffRecord> {
    const so = await storage(a.p.ledger.signoff({ ...a.scope, signoffId }));
    if (!so) return refuse(404, 'not-found', 'No such sign-off for this case.');
    if (so.state !== 'audited' || so.invalidatedAt || (signed && differing(so, signed).length))
      return refuse(409, 'signoff-not-effective', 'This sign-off is not effective. Sign off the current candidate again.');
    const s = await candidate(a, so.candidateId);
    const why = !s ? 'candidate-missing' : differing(so, identityOf(s)).length ? 'candidate-changed' : signoffBlocker(s) ? 'candidate-blocked'
      : canonical([...newWarnings(s)].sort()) !== canonical(so.acknowledgements.map((x) => x.fingerprint)) || canonical([...s.validation.warningFingerprints].sort()) !== canonical(so.warningFingerprints) ? 'warnings-changed' : null;
    if (why) {
      await storage(a.p.ledger.invalidateSignoff({ ...a.scope, signoffId, at: a.p.now().toISOString(), reason: why }));
      return refuse(409, 'signoff-stale', 'The candidate changed since sign-off. Review and sign off the current candidate.', { reason: why });
    }
    return so;
  }

  return {
    /** POST /operator/publication/[caseId]/signoffs: one human sign-off of one exact candidate. Never publishes. */
    signOff: (r: PublicationRequest) => handle(async () => {
      const a = await admit(r), b = a.body;
      if (!exactKeys(b, ['operationId', 'candidateId', 'identity', 'acknowledgements', 'selfApproval'])) return refuse(422, 'invalid-request', 'The sign-off has missing or unknown fields.');
      const { operationId, candidateId, identity: claimed, acknowledgements, selfApproval } = b;
      if (typeof operationId !== 'string' || !OPERATION.test(operationId)) return refuse(422, 'invalid-request', 'The operation id is invalid.');
      if (!text(candidateId, 128) || !PART.test(candidateId)) return refuse(422, 'invalid-request', 'The candidate id is invalid.');
      if (!plain(claimed) || !exactKeys(claimed, IDENTITY_KEYS) || !IDENTITY_KEYS.every((k) => text(claimed[k]))) return refuse(422, 'invalid-request', 'Name the exact candidate identity you reviewed.');
      if (typeof selfApproval !== 'boolean') return refuse(422, 'invalid-request', 'selfApproval must be true or false.');
      if (!Array.isArray(acknowledgements) || acknowledgements.length > MAX_ACKS) return refuse(422, 'invalid-request', 'acknowledgements must be a list.');
      const acks: SignoffAcknowledgement[] = [];
      for (const x of acknowledgements) {
        if (!plain(x) || !exactKeys(x, ['fingerprint', 'reason']) || typeof x.fingerprint !== 'string' || !FINGERPRINT.test(x.fingerprint) || typeof x.reason !== 'string') return refuse(422, 'invalid-request', 'Each acknowledgement names one warning fingerprint and a reason.');
        const reason = x.reason.trim();
        if (!reason || reason.length > MAX_REASON) return refuse(422, 'ack-reason', 'Every acknowledged warning needs a reason.');
        acks.push({ fingerprint: x.fingerprint, reason });
      }

      const s = await candidate(a, candidateId);
      if (!s) return refuse(404, 'not-found', 'No such candidate for this case.');
      const current = identityOf(s), stale = differing({ candidateId, ...(claimed as Omit<SignoffIdentity, 'candidateId'>) }, current);
      if (stale.length) return refuse(409, 'stale-candidate', 'The candidate changed since you reviewed it. Review the current version.', { fields: stale });
      const blocker = signoffBlocker(s);
      if (blocker) return refuse(blockerResponse[blocker.code][0], blocker.code, blockerResponse[blocker.code][1], { detail: blocker.detail });

      // Acknowledgements cover exactly the new warnings: none missing, none extra, none twice. An error is never acknowledgeable.
      const fresh = newWarnings(s), named = acks.map((x) => x.fingerprint), unique = new Set(named);
      if (unique.size !== named.length || named.some((f) => !fresh.includes(f))) return refuse(422, 'ack-not-exact', 'Acknowledge exactly the new warnings, each once.');
      const missing = fresh.filter((f) => !unique.has(f));
      if (missing.length) return refuse(422, 'ack-incomplete', 'Every new warning needs an acknowledgement with a reason.', { missing });

      const preparer = a.principal.issuer === s.preparedBy.issuer && a.principal.subject === s.preparedBy.subject;
      if (preparer && !selfApproval) return refuse(422, 'self-approval-unconfirmed', 'You prepared this candidate. Confirm that you approve your own work.');
      if (!preparer && selfApproval) return refuse(422, 'self-approval-mismatch', 'Only the preparer can record a self-approval.');

      const requestSha256 = await sha256Hex(canonical({ route: 'signoff', caseId: a.caseId, actor: a.actor, body: { ...b, acknowledgements: acks } }));
      const signedAt = a.p.now().toISOString();
      const record: SignoffRecord = {
        ...current, signoffId: `so-${operationId}`, operationId, requestSha256, clientId: a.p.clientId, caseId: a.caseId,
        warningFingerprints: [...s.validation.warningFingerprints].sort(), acknowledgements: [...acks].sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1)),
        signer: a.actor, preparedBy: { issuer: s.preparedBy.issuer, subject: s.preparedBy.subject }, selfApproval: preparer,
        signedAt, auditEvent: await auditEvent(a, 'publication.signoff', `so-${operationId}`, current.resultsVersion, signedAt),
        state: 'recorded', invalidatedAt: null, invalidatedReason: null,
      };
      const out = await storage(a.p.ledger.recordSignoff(record));
      if (out.kind === 'operation-reused') return refuse(409, 'operation-reused', 'This operation id was already used for a different request.');
      if (out.record.invalidatedAt) return refuse(409, 'signoff-stale', 'This sign-off was invalidated by a later change. Review the current candidate.');
      // Only an audited sign-off is effective; a retry of the same operation settles one whose event did not persist.
      const settles = out.record.state !== 'audited';
      if (settles) {
        await audit(a, out.record.auditEvent);
        await storage(a.p.ledger.settleSignoff({ ...a.scope, signoffId: out.record.signoffId }));
      }
      return json(settles ? 201 : 200, { signoffId: out.record.signoffId, state: 'signed-off', resultsVersion: out.record.resultsVersion, selfApproval: out.record.selfApproval });
    }),

    /** POST /operator/publication/[caseId]/publish: publish one audited, still-current sign-off by compare-and-set. */
    publish: (r: PublicationRequest) => handle(async () => {
      const a = await admit(r), b = a.body;
      if (!exactKeys(b, ['operationId', 'signoffId', 'expected'])) return refuse(422, 'invalid-request', 'The request has missing or unknown fields.');
      const { operationId, signoffId } = b, expected = expectedOf(b.expected);
      if (typeof operationId !== 'string' || !OPERATION.test(operationId) || typeof signoffId !== 'string' || !SIGNOFF.test(signoffId) || !expected) return refuse(422, 'invalid-request', 'The request is invalid.');

      const requestSha256 = await sha256Hex(canonical({ route: 'publish', caseId: a.caseId, actor: a.actor, body: b }));
      // Reconcile even pending/failed operations BEFORE reading a possibly edited candidate. The storage receipt,
      // not a best-effort ledger outcome update or today's pointer, is the durable proof of application.
      const prior = await storage(a.p.ledger.operation({ ...a.scope, operationId }));
      if (prior) {
        if (prior.requestSha256 !== requestSha256) return refuse(409, 'operation-reused', 'This operation id was already used for a different request.');
        return pointer(a, prior);
      }
      const so = await effectiveSignoff(a, signoffId), at = a.p.now().toISOString();
      const { candidateId, linkId, submissionRevisionId, submissionManifestSha256, resultsVersion, manifestSha256, packageInputRevisionId, diagnosticsSha256, validatorVersion, snapshotRevision } = so;
      const signedIdentity: SignoffIdentity = { candidateId, linkId, submissionRevisionId, submissionManifestSha256, resultsVersion, manifestSha256, packageInputRevisionId, diagnosticsSha256, validatorVersion, snapshotRevision };
      const op: OperationRecord = { operationId, requestSha256, ...a.scope, kind: 'publish', signoffId, resultsVersion: so.resultsVersion, expected, actor: a.actor,
        signedIdentity, auditEvent: await auditEvent(a, 'publication.publish', operationId, so.resultsVersion, at), state: 'pending', reason: null, at };
      return pointer(a, op);
    }),

    /** POST /operator/publication/[caseId]/withdraw: withdraw the published results version only. */
    withdraw: (r: PublicationRequest) => handle(async () => {
      const a = await admit(r), b = a.body;
      if (!exactKeys(b, ['operationId', 'resultsVersion', 'expected'])) return refuse(422, 'invalid-request', 'The request has missing or unknown fields.');
      const { operationId, resultsVersion } = b, expected = expectedOf(b.expected);
      if (typeof operationId !== 'string' || !OPERATION.test(operationId) || typeof resultsVersion !== 'string' || !RV.test(resultsVersion) || !expected) return refuse(422, 'invalid-request', 'The request is invalid.');
      if (expected.kind !== 'published' || expected.resultsVersion !== resultsVersion) return refuse(422, 'invalid-request', 'Withdraw the version you expect to be published.');
      const rv = resultsVersion as ResultsVersion;
      const requestSha256 = await sha256Hex(canonical({ route: 'withdraw', caseId: a.caseId, actor: a.actor, body: b }));
      const at = a.p.now().toISOString();
      const op: OperationRecord = { operationId, requestSha256, ...a.scope, kind: 'withdraw', signoffId: null, resultsVersion: rv, expected, actor: a.actor,
        signedIdentity: null, auditEvent: await auditEvent(a, 'publication.withdraw', operationId, rv, at), state: 'pending', reason: null, at };
      return pointer(a, op);
    }),
  };

  function intentOf({ state: _state, reason: _reason, ...intent }: OperationRecord): PublicationIntent { return intent; }

  /** Durable intent -> serialized recheck/CAS/receipt -> recoverable ledger outcome -> stable audit envelope. */
  async function pointer(a: Admitted, op: OperationRecord) {
    const begun = await storage(a.p.ledger.beginOperation(op));
    if (begun.kind === 'operation-reused') return refuse(409, 'operation-reused', 'This operation id was already used for a different request.');
    const rec = begun.record, intent = intentOf(rec), key = { ...a.scope, operationId: rec.operationId };
    if (rec.state === 'refused') return refuse(409, rec.reason === 'conflict' ? 'publication-conflict' : 'publication-refused', 'This operation was refused; nothing changed.');
    const receipt = async () => {
      const saved = await storage(a.p.publisher.receipt(key));
      if (saved && canonical(saved.intent) !== canonical(intent)) return unavailable('receipt-mismatch', 'The operation receipt does not match its durable intent.');
      return saved;
    };
    const applied = await receipt();
    if (!applied && (rec.state === 'applied' || rec.state === 'audited')) return unavailable('receipt-missing', 'The applied operation receipt cannot be read. Retry with the same operation id.');
    if (rec.state === 'pending' || rec.state === 'failed') {
      if (!applied) {
        // The adapter, not this outer function, chooses the atomic commit boundary. These checks MUST run inside it.
        const recheck = async () => {
          await a.recheckAuthority();
          if (intent.kind === 'publish') {
            if (!intent.signoffId || !intent.signedIdentity) return unavailable();
            await effectiveSignoff(a, intent.signoffId, intent.signedIdentity);
          }
        };
        let out: PointerOutcome;
        const authority = { ...a.scope, principal: a.principal, sessionId: a.sessionId, capability: 'publish' as const };
        try { out = await a.p.publisher[rec.kind]({ intent, authority, recheck }); } catch (e) {
          if (e instanceof Refusal) throw e;
          await storage(a.p.ledger.finishOperation({ ...key, state: 'failed', reason: 'storage-fault' }));
          // A commit acknowledgement can be lost. Never claim nothing changed when the result is uncertain.
          return refuse(503, 'storage-unavailable', 'Publication outcome is not confirmed. Retry with the same operation id.');
        }
        if (out.kind === 'guard-refused') {
          if (out.reason === 'forbidden') return refuse(403, 'forbidden', 'You cannot publish results for this case.');
          if (out.reason === 'invalid-session') return refuse(401, 'unauthenticated', 'Sign in to continue.');
          return refuse(409, 'signoff-stale', 'The candidate or sign-off changed before commit. Review and sign off the current candidate.');
        }
        if (out.kind !== 'applied') {
          await storage(a.p.ledger.finishOperation({ ...key, state: 'refused', reason: out.kind === 'conflict' ? 'conflict' : `refused:${out.reason}`.slice(0, 200) }));
          return out.kind === 'conflict'
            ? refuse(409, 'publication-conflict', 'The publication changed since you looked. Reload and try again.', { current: out.current })
            : refuse(409, 'publication-refused', 'Storage refused this change; nothing changed.');
        }
        if (!await receipt()) return unavailable('receipt-missing', 'The apply receipt cannot be read. Retry with the same operation id.');
      }
      await storage(a.p.ledger.finishOperation({ ...key, state: 'applied', reason: null }));
    }
    if (rec.state !== 'audited') {
      await audit(a, rec.auditEvent);
      await storage(a.p.ledger.settleOperation(key));
    }
    const state: PublicationState = rec.kind === 'publish' ? { kind: 'published', resultsVersion: rec.resultsVersion } : { kind: 'withdrawn', resultsVersion: rec.resultsVersion };
    return json(200, { operationId: rec.operationId, publication: state });
  }
}
export type PublicationController = ReturnType<typeof createNativePublication>;
