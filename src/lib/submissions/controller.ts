import type { CaseId, Identity, Principal, SessionId } from '../server/runtime/contracts.ts';
import { codeOf } from '../server/runtime/errors.ts';
import { digest } from '../server/runtime/data.ts';
import { id } from '../server/runtime/ids.ts';
import { looksLikePdf, readAtMost, readExactly } from './body.ts';
import { safePath } from './path.ts';
import type { IntakePorts, OriginalOutcome, SubmissionManifest, UploadRecord } from './ports.ts';

/** What one intake request carries: the request, its URL, the route params and the request's identity (the existing contract). */
export interface IntakeRequest { request: Request; url: URL; params: Partial<Record<'caseId' | 'operationId', string>>; identity: Identity }

/** The stage a person sees. Nothing here claims processing: a finalized submission has no results until an operator publishes some. */
export type Stage = 'received' | 'stored-not-finalized' | 'finalized';
export interface SubmissionView {
  operationId: string; path: string; size: number; stage: Stage; results: 'none'; manifest: SubmissionManifest | null;
  /** Where the parent's operator flow downloads each finalized original: the existing case originals route (GRS-115 assets). */
  handoff: { path: string; href: string }[];
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const FIELDS = ['mediaType', 'operationId', 'path', 'sha256', 'size'].join();
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const fail = (status: number, code: string, message: string) => json(status, { code, message }, status === 503 ? { 'retry-after': '2' } : {});
class Refusal { readonly response: Response; constructor(response: Response) { this.response = response; } }
const refuse = (status: number, code: string, message: string): never => { throw new Refusal(fail(status, code, message)); };

// Authority refusals of the identity and capability ports. A write without the capability is 403 whatever the reason
// (unknown case, no capability, another case), so a refusal does not tell which; a read refusal is 404, as for the case pages.
function authorityRefusal(e: unknown, access: 'read' | 'write'): never {
  const code = codeOf(e);
  if (code === 'unauthenticated' || code === 'invalid-session') refuse(401, 'unauthenticated', 'Sign in to continue.');
  if (code === 'wrong-client') refuse(401, 'wrong-client', 'This session belongs to another client. Sign in for this client.');
  if (code === 'forbidden' || code === 'not-found') {
    if (access === 'read') refuse(404, 'not-found', 'Not found.');
    refuse(403, 'forbidden', 'You cannot supply files for this case.');
  }
  return refuse(503, 'identity-unavailable', 'Sign-in is unavailable. Try again shortly.');
}

// GRS-115 refusals. Retryable faults throw `storage-unavailable` and answer 503; a refusal is final for this operation.
function storeRefusal(o: Exclude<OriginalOutcome, { kind: 'declared' | 'stored' | 'finalized' }>): never {
  switch (o.reason) {
    case 'over-budget': return refuse(413, 'too-large', 'The file is larger than this deployment accepts.');
    case 'over-quota': return refuse(429, 'over-quota', 'This case has reached its upload allowance.');
    case 'operation-reused': return refuse(409, 'operation-reused', 'This upload id was already used for a different file.');
    case 'digest-mismatch': return refuse(422, 'digest-mismatch', 'The file received does not match the file declared.');
    case 'not-declared': return refuse(409, 'not-declared', 'The original store has no declaration for this upload.');
    default: return refuse(409, 'refused', 'The original store refused this file.');
  }
}

/** The intake's HTTP controller: one JSON declaration, then one raw PDF body, then reads. Each answer is a JSON Response. */
export function createIntakeController(ports: IntakePorts | null) {
  // Checks that need no port and no identity, then the ports, then authority. Nothing before the return reads a body.
  async function admit(r: IntakeRequest, write: { contentType: string } | null) {
    if (write) {
      // The hosted entry refuses a cross-origin write before routing; this controller refuses it again rather than rely on it.
      if (r.request.headers.get('origin') !== r.url.origin) refuse(403, 'cross-origin', 'Cross-origin writes are refused.');
      // A non-simple content type also forces a CORS preflight, which this deployment never grants.
      if ((r.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== write.contentType) refuse(415, 'unsupported-media-type', `Send ${write.contentType}.`);
    }
    if (!ports || !ports.budget || !ports.repository || !ports.originals || !ports.authorizeUpload) return refuse(503, 'intake-unavailable', 'File intake is not available on this deployment yet.');
    const raw = r.params.caseId;
    if (!raw || !PART.test(raw)) refuse(404, 'not-found', 'Not found.');
    const caseId = id('case', raw!) as CaseId;
    const who = r.identity;
    if (who.kind !== 'verified') refuse(401, 'unauthenticated', 'Sign in to continue.');
    if (who.clientId !== ports.clientId) refuse(401, 'wrong-client', 'This session belongs to another client. Sign in for this client.');
    const { principal, sessionId } = who as { principal: Principal; sessionId: SessionId };
    try {
      await who.checkRevocation();
      if (write) await ports.authorizeUpload({ principal, sessionId, clientId: ports.clientId, caseId });
      else await who.authorize({ caseId, operation: 'read' });
    } catch (e) { authorityRefusal(e, write ? 'write' : 'read'); }
    return { caseId, principal, budget: ports.budget, repository: ports.repository, originals: ports.originals, scope: { clientId: ports.clientId, caseId } };
  }
  const operationOf = (r: IntakeRequest) => {
    const op = r.params.operationId;
    return op && OPERATION.test(op) ? op : refuse(404, 'not-found', 'Not found.');
  };
  const storage = <T>(work: Promise<T>): Promise<T> => work.catch((e) => {
    if (codeOf(e) === 'forbidden') refuse(403, 'forbidden', 'You cannot supply files for this case.');
    return refuse(503, 'storage-unavailable', 'File storage is unavailable. Try again with the same upload.');
  });
  const handle = (work: () => Promise<Response>) => work().catch((e) => { if (e instanceof Refusal) return e.response; throw e; });
  const view = (u: UploadRecord, m: SubmissionManifest | null): SubmissionView => ({
    operationId: u.operationId, path: u.path, size: u.size, results: 'none', manifest: m,
    stage: m ? 'finalized' : u.state === 'received' ? 'received' : 'stored-not-finalized',
    handoff: m ? m.files.map((f) => ({ path: f.path, href: `/cases/${encodeURIComponent(m.caseId)}/originals/${encodeURIComponent(f.assetId)}` })) : [],
  });

  return {
    /** POST /client/intake/[caseId]/submissions: declare one PDF (operationId, path, size, sha256, mediaType). */
    declare: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/json' });
      const body = await readAtMost(r.request.body, a.budget.maxMetadataBytes);
      if (body.kind !== 'ok') return fail(413, 'too-large', 'The declaration is too large.');
      let m: Record<string, unknown>;
      try {
        const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.bytes));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError();
        m = v as Record<string, unknown>;
      } catch { return fail(422, 'invalid-declaration', 'Send one JSON object.'); }
      if (Object.keys(m).sort().join() !== FIELDS) return fail(422, 'invalid-declaration', 'The declaration has missing or unknown fields.');
      const { operationId, size, sha256, mediaType } = m;
      if (typeof operationId !== 'string' || !OPERATION.test(operationId)) return fail(422, 'invalid-declaration', 'The upload id is invalid.');
      if (mediaType !== 'application/pdf') return fail(422, 'invalid-declaration', 'Only PDF files are accepted.');
      if (typeof sha256 !== 'string' || !SHA.test(sha256)) return fail(422, 'invalid-declaration', 'The SHA-256 is invalid.');
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) return fail(422, 'invalid-declaration', 'The size is invalid.');
      if (size > a.budget.maxFileBytes) return fail(413, 'too-large', 'The file is larger than this deployment accepts.');
      const path = safePath(m.path);
      if (!path) return fail(422, 'invalid-path', 'The file path is not a safe relative path to a .pdf file.');
      const assetId = `sub-${operationId}`;
      const at = ports!.now().toISOString();
      const own = await storage(a.repository.declare({ ...a.scope, operationId, assetId, path: path.path, filename: path.filename, mediaType, size, sha256, principal: { issuer: a.principal.issuer, subject: a.principal.subject }, at }));
      if (own.kind === 'operation-reused') return fail(409, 'operation-reused', 'This upload id was already used for a different file.');
      const out = await storage(a.originals.declare({ caseId: a.caseId, operationId, assetId, filename: path.filename, mediaType, size, sha256 }));
      if (out.kind === 'refused') storeRefusal(out);
      return json(own.repeated ? 200 : 201, { operationId, stage: 'received', path: path.path, size });
    }),

    /** PUT /client/intake/[caseId]/submissions/[operationId]: the declared PDF's exact bytes; finalizes and records the submission. */
    upload: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/pdf' });
      const operationId = operationOf(r);
      const u = await storage(a.repository.upload({ ...a.scope, operationId }));
      if (!u) return fail(404, 'not-declared', 'Declare the file before sending it.');
      if (u.size > a.budget.maxFileBytes) return fail(413, 'too-large', 'The file is larger than this deployment accepts.');
      const body = await readExactly(r.request.body, u.size);
      if (body.kind === 'too-large') return fail(413, 'too-large', 'More bytes arrived than were declared.');
      if (body.kind === 'incomplete') return fail(400, 'incomplete-body', 'The upload was interrupted. Send the whole file again with the same upload id.');
      // The bytes decide, not the declaration: their own size and digest, then a PDF header and end marker.
      if ((await digest(body.bytes)) !== u.sha256) return fail(422, 'digest-mismatch', 'The file received does not match the file declared.');
      if (!looksLikePdf(body.bytes)) return fail(422, 'not-a-pdf', 'The file is not a PDF.');
      const done = u.state === 'finalized' ? await storage(a.repository.revision({ ...a.scope, operationId })) : null;
      if (done) return json(200, view(u, done));
      // Store (the store re-verifies), record the acknowledged provenance, finalize the original, then record the manifest.
      if (u.state === 'received') {
        const put = await storage(a.originals.put({ caseId: a.caseId, operationId, bytes: body.bytes }));
        if (put.kind === 'refused') storeRefusal(put);
        await storage(a.repository.markStored({ ...a.scope, operationId, at: ports!.now().toISOString() }));
      }
      const fin = await storage(a.originals.finalize({ caseId: a.caseId, operationId }));
      if (fin.kind === 'refused') storeRefusal(fin);
      let manifest: SubmissionManifest;
      try { manifest = await a.repository.commitRevision({ ...a.scope, operationId, at: ports!.now().toISOString() }); }
      catch { return fail(503, 'manifest-unrecorded', 'The file is stored but its submission could not be recorded. Send it again with the same upload id.'); }
      const repeated = u.state === 'finalized';
      return json(repeated ? 200 : 201, view({ ...u, state: 'finalized' }, manifest));
    }),

    /** GET /client/intake/[caseId]/submissions/[operationId]: the stage and, once finalized, the manifest and download handoff. */
    read: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, null);
      const operationId = operationOf(r);
      const u = await storage(a.repository.upload({ ...a.scope, operationId }));
      if (!u) return fail(404, 'not-found', 'Not found.');
      const m = u.state === 'finalized' ? await storage(a.repository.revision({ ...a.scope, operationId })) : null;
      return json(200, view(u, m));
    }),

    /** GET /client/intake/[caseId]/submissions: every upload of the case, oldest first, with its stage. */
    list: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, null);
      const rows = await storage(a.repository.list(a.scope));
      return json(200, { submissions: rows.map((x) => view(x.upload, x.manifest)) });
    }),
  };
}
export type IntakeController = ReturnType<typeof createIntakeController>;
