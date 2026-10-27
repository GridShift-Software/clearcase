import type { CaseId, Identity, Principal, SessionId } from '../server/runtime/contracts.ts';
import { codeOf } from '../server/runtime/errors.ts';
import { digest } from '../server/runtime/data.ts';
import { id } from '../server/runtime/ids.ts';
import { looksLikePdf, readAtMost, readExactly } from './body.ts';
import { revisionIdOf } from './repository.ts';
import { fileSetDigest, MAX_SET_FILES } from './file-set.ts';
import { safePath } from './path.ts';
import type { IntakePorts, OriginalOutcome, SealStep, SetRecord, SetState, SubmissionManifest, UploadRecord } from './ports.ts';

/** What one intake request carries: the request, its URL, the route params and the request's identity (the existing contract). */
export interface IntakeRequest { request: Request; url: URL; params: Partial<Record<'caseId' | 'operationId' | 'setId', string>>; identity: Identity }

/** The stage a person sees. Nothing here claims processing: a finalized submission has no results until an operator publishes some. */
export type Stage = 'received' | 'stored-not-finalized' | 'finalized';
export interface SubmissionView {
  operationId: string; path: string; size: number; stage: Stage; results: 'none'; manifest: SubmissionManifest | null;
  /** Where the parent's operator flow downloads each finalized original: the existing case originals route (GRS-115 assets). */
  handoff: { path: string; href: string }[];
}

/** One multi-file submission as the client sees it. `revision` is named only once the set is sealed, the one final state. */
export interface SetView {
  setId: string; state: SetState; fileCount: number; totalBytes: number; declared: number; stored: number; finalized: number;
  filesSha256: string | null; revision: { revisionId: string; sequence: number } | null;
}
/** A file of a set: received (declared), stored (its bytes acknowledged; reserved once the seal starts) or finalized. */
export interface SetFileView { operationId: string; path: string; size: number; sha256: string; stage: 'received' | 'stored' | 'finalized' }

/**
 * One seal request's default bounds (U16), sized for Workers Paid as U15 sized its steps: 32 originals of a v5 export average
 * about 1.1 MB, so a step hashes about 35 MB, makes about 32 x 5 = 160 D1 and R2 calls (of 1,000 D1 queries and 10,000
 * subrequests per request) and stops at 20 s of wall time. A 1,689-file set seals in about 53 requests.
 */
export const SEAL_STEP: SealStep = Object.freeze({ files: 32, bytes: 128 << 20, ms: 20_000 });
const SET_PAGE = 500;
const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const FIELDS = ['mediaType', 'operationId', 'path', 'sha256', 'size'].join();
const SET_FIELDS = ['fileCount', 'setId', 'totalBytes'].join();
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
// The refusals of the identity and upload authority ports. Any other fault, an identity outage included (writerAccess), is retryable.
const AUTHORITY = new Set(['unauthenticated', 'invalid-session', 'wrong-client', 'forbidden']);

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
    return { caseId, principal, mayUpload: ports.mayUpload ?? null, budget: ports.budget, repository: ports.repository, originals: ports.originals, scope: { clientId: ports.clientId, caseId } };
  }
  const operationOf = (r: IntakeRequest) => {
    const op = r.params.operationId;
    return op && OPERATION.test(op) ? op : refuse(404, 'not-found', 'Not found.');
  };
  // The original store asks the upload authority again at each step (services.ts), so a session that ends during the request
  // (a ~60 s Clerk token, 3 to 8 s requests) is refused there: it answers as admission would, a 401 the page reloads for.
  const storage = <T>(work: Promise<T>): Promise<T> => work.catch((e) => {
    if (AUTHORITY.has(codeOf(e)!)) authorityRefusal(e, 'write');
    return refuse(503, 'storage-unavailable', 'File storage is unavailable. Try again with the same upload.');
  });
  const handle = (work: () => Promise<Response>) => work().catch((e) => { if (e instanceof Refusal) return e.response; throw e; });
  // One JSON object of at most the metadata budget, with exactly `fields`; a refusal is thrown as its answer.
  async function jsonBody(r: IntakeRequest, max: number, fields: string): Promise<Record<string, unknown>> {
    const body = await readAtMost(r.request.body, max);
    if (body.kind === 'incomplete') refuse(400, 'incomplete-body', 'The request was interrupted. Send the declaration again.');
    if (body.kind !== 'ok') refuse(413, 'too-large', 'The declaration is too large.');
    let m: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((body as { bytes: Uint8Array }).bytes));
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) m = v as Record<string, unknown>;
    } catch { /* answered below */ }
    if (!m) return refuse(422, 'invalid-declaration', 'Send one JSON object.');
    if (Object.keys(m).sort().join() !== fields) refuse(422, 'invalid-declaration', 'The declaration has missing or unknown fields.');
    return m;
  }
  // One PDF's declaration (operationId, path, size, sha256, mediaType), checked against the budget before anything is written.
  async function declaration(r: IntakeRequest, budget: { maxMetadataBytes: number; maxFileBytes: number }) {
    const m = await jsonBody(r, budget.maxMetadataBytes, FIELDS);
    const { operationId, size, sha256, mediaType } = m;
    if (typeof operationId !== 'string' || !OPERATION.test(operationId)) refuse(422, 'invalid-declaration', 'The upload id is invalid.');
    if (mediaType !== 'application/pdf') refuse(422, 'invalid-declaration', 'Only PDF files are accepted.');
    if (typeof sha256 !== 'string' || !SHA.test(sha256)) refuse(422, 'invalid-declaration', 'The SHA-256 is invalid.');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) refuse(422, 'invalid-declaration', 'The size is invalid.');
    if ((size as number) > budget.maxFileBytes) refuse(413, 'too-large', 'The file is larger than this deployment accepts.');
    const path = safePath(m.path);
    if (!path) return refuse(422, 'invalid-path', 'The file path is not a safe relative path to a .pdf file.');
    const op = operationId as string;
    return { upload: { operationId: op, assetId: `sub-${op}`, path: path.path, filename: path.filename, mediaType: 'application/pdf' as const, size: size as number, sha256: sha256 as string }, pathKey: path.key };
  }
  type Admitted = Awaited<ReturnType<typeof admit>>;
  type Declared = Awaited<ReturnType<typeof declaration>>['upload'];
  async function declareOriginal(a: Admitted, u: Declared) {
    const out = await storage(a.originals.declare({ caseId: a.caseId, operationId: u.operationId, assetId: u.assetId, filename: u.filename, mediaType: u.mediaType, size: u.size, sha256: u.sha256 }));
    if (out.kind === 'refused') storeRefusal(out);
  }
  // A received upload's exact bytes, checked against its declaration, then stored and recorded as stored.
  async function store(r: IntakeRequest, u: UploadRecord) {
    const body = await readExactly(r.request.body, u.size);
    if (body.kind === 'too-large') refuse(413, 'too-large', 'More bytes arrived than were declared.');
    if (body.kind === 'incomplete') refuse(400, 'incomplete-body', 'The upload was interrupted. Send the whole file again with the same upload id.');
    const bytes = (body as { bytes: Uint8Array }).bytes;
    if ((await digest(bytes)) !== u.sha256) refuse(422, 'digest-mismatch', 'The file received does not match the file declared.');
    if (!looksLikePdf(bytes)) refuse(422, 'not-a-pdf', 'The file is not a PDF.');
    return bytes;
  }
  async function put(a: Admitted, operationId: string, bytes: Uint8Array) {
    const out = await storage(a.originals.put({ caseId: a.caseId, operationId, bytes }));
    if (out.kind === 'refused') storeRefusal(out);
    await storage(a.repository.markStored({ ...a.scope, operationId, at: ports!.now().toISOString() }));
  }
  const setIdOf = (r: IntakeRequest) => {
    const id = r.params.setId;
    return id && OPERATION.test(id) ? id : refuse(404, 'not-found', 'Not found.');
  };
  const setView = (s: SetRecord): SetView => ({
    setId: s.setId, state: s.state, fileCount: s.fileCount, totalBytes: s.totalBytes, declared: s.declared, stored: s.stored, finalized: s.finalized,
    filesSha256: s.filesSha256, revision: s.state === 'sealed' && s.sequence !== null ? { revisionId: revisionIdOf(s.setId), sequence: s.sequence } : null,
  });
  const fileView = (u: UploadRecord): SetFileView => ({
    operationId: u.operationId, path: u.path, size: u.size, sha256: u.sha256, stage: u.state === 'received' ? 'received' : u.state === 'finalized' ? 'finalized' : 'stored',
  });
  async function setOrNotFound(a: Admitted, setId: string) {
    return (await storage(a.repository.set({ ...a.scope, setId }))) ?? refuse(404, 'not-found', 'Not found.');
  }
  const view = (u: UploadRecord, m: SubmissionManifest | null): SubmissionView => ({
    operationId: u.operationId, path: u.path, size: u.size, results: 'none', manifest: m,
    stage: m ? 'finalized' : u.state === 'received' ? 'received' : 'stored-not-finalized', // stored and reserved are both pending
    handoff: m ? m.files.map((f) => ({ path: f.path, href: `/cases/${encodeURIComponent(m.caseId)}/originals/${encodeURIComponent(f.assetId)}` })) : [],
  });

  return {
    /** POST /client/intake/[caseId]/submissions: declare one PDF (operationId, path, size, sha256, mediaType). */
    declare: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/json' });
      const d = await declaration(r, a.budget);
      const own = await storage(a.repository.declare({ ...a.scope, ...d.upload, principal: { issuer: a.principal.issuer, subject: a.principal.subject }, at: ports!.now().toISOString() }));
      if (own.kind === 'operation-reused') return fail(409, 'operation-reused', 'This upload id was already used for a different file.');
      await declareOriginal(a, d.upload);
      return json(own.repeated ? 200 : 201, { operationId: d.upload.operationId, stage: 'received', path: d.upload.path, size: d.upload.size });
    }),

    /** PUT /client/intake/[caseId]/submissions/[operationId]: the declared PDF's exact bytes; finalizes and records the submission. */
    upload: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/pdf' });
      const operationId = operationOf(r);
      const u = await storage(a.repository.upload({ ...a.scope, operationId }));
      if (!u) return fail(404, 'not-declared', 'Declare the file before sending it.');
      // A file of a set is finalized only by its set's seal, never as a submission of its own.
      if (await storage(a.repository.setOf({ ...a.scope, operationId }))) return fail(409, 'set-member', 'This file belongs to a set. Send it through its set.');
      if (u.size > a.budget.maxFileBytes) return fail(413, 'too-large', 'The file is larger than this deployment accepts.');
      // A finalized replay and a first upload read the body: the bytes decide, not the declaration. A stored or reserved
      // upload does not: its bytes were verified and acknowledged by the original store on an earlier request, so the retry
      // finishes the remaining steps without reading or storing the file again.
      if (u.state === 'received' || u.state === 'finalized') {
        const bytes = await store(r, u);
        const done = u.state === 'finalized' ? await storage(a.repository.revision({ ...a.scope, operationId })) : null;
        if (done) return json(200, view(u, done));
        // Store (the store re-verifies), then record the acknowledged provenance.
        if (u.state === 'received') await put(a, operationId, bytes);
      }
      // Precommit the manifest facts durably, THEN make the original readable, THEN mark the submission final: the original
      // is never visible without its owned record. A fault at any step answers 503 and a retry resumes from the durable state.
      try { await a.repository.reserveRevision({ ...a.scope, operationId, at: ports!.now().toISOString() }); }
      catch { return fail(503, 'manifest-unrecorded', 'The file is stored but its submission could not be recorded yet. Try again with the same upload id; the file need not be sent again.'); }
      const fin = await storage(a.originals.finalize({ caseId: a.caseId, operationId }));
      if (fin.kind === 'refused') storeRefusal(fin);
      let manifest: SubmissionManifest;
      try { manifest = await a.repository.commitRevision({ ...a.scope, operationId, at: ports!.now().toISOString() }); }
      catch { return fail(503, 'manifest-unrecorded', 'The file is stored but its submission could not be marked final yet. Try again with the same upload id; the file need not be sent again.'); }
      const repeated = u.state === 'finalized';
      return json(repeated ? 200 : 201, view({ ...u, state: 'finalized' }, manifest));
    }),

    /** POST /client/intake/[caseId]/sets: open a set of PDFs (setId, fileCount, totalBytes). The cap is checked before any write. */
    openSet: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/json' });
      const m = await jsonBody(r, a.budget.maxMetadataBytes, SET_FIELDS);
      const { setId, fileCount, totalBytes } = m;
      if (typeof setId !== 'string' || !OPERATION.test(setId)) return fail(422, 'invalid-declaration', 'The set id is invalid.');
      if (typeof fileCount !== 'number' || !Number.isSafeInteger(fileCount) || fileCount < 1) return fail(422, 'invalid-declaration', 'The file count is invalid.');
      if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < fileCount) return fail(422, 'invalid-declaration', 'The total size is invalid.');
      if (fileCount > MAX_SET_FILES) return fail(413, 'too-many-files', `A set holds at most ${MAX_SET_FILES} files.`);
      if (totalBytes > fileCount * a.budget.maxFileBytes) return fail(413, 'too-large', 'The files are larger than this deployment accepts.');
      const out = await storage(a.repository.openSet({ ...a.scope, setId, fileCount, totalBytes, principal: { issuer: a.principal.issuer, subject: a.principal.subject }, at: ports!.now().toISOString() }));
      if (out.kind === 'set-reused') return fail(409, 'operation-reused', 'This set id was already used for a different set or upload.');
      const s = await setOrNotFound(a, setId);
      return json(out.repeated ? 200 : 201, { set: setView(s) });
    }),

    /** GET /client/intake/[caseId]/sets/[setId]?after=: the set and one page of its files in path order, for progress and resume. */
    readSet: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, null);
      const s = await setOrNotFound(a, setIdOf(r));
      const after = r.url.searchParams.get('after');
      if (after !== null && (after.length > 1024 || !after.isWellFormed())) return fail(422, 'invalid-cursor', 'The page cursor is invalid.');
      const page = ports!.setPage ?? SET_PAGE;
      const files = await storage(a.repository.setFiles({ ...a.scope, setId: s.setId, after, limit: page }));
      return json(200, { set: setView(s), files: files.map((f) => fileView(f.upload)), next: files.length === page ? files[files.length - 1]!.pathKey : null });
    }),

    /** POST /client/intake/[caseId]/sets/[setId]/files: declare one PDF of an open set, as for a single file. */
    declareSetFile: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/json' });
      const setId = setIdOf(r);
      const d = await declaration(r, a.budget);
      const own = await storage(a.repository.declareSetFile({ ...a.scope, ...d.upload, setId, pathKey: d.pathKey, principal: { issuer: a.principal.issuer, subject: a.principal.subject }, at: ports!.now().toISOString() }));
      switch (own.kind) {
        case 'no-set': return fail(404, 'not-found', 'Not found.');
        case 'set-closed': return fail(409, 'set-closed', 'This set is sealed or being sealed. A new set is a new submission.');
        case 'set-full': return fail(409, 'set-full', 'This set already holds the number of files it was opened for.');
        case 'path-taken': return fail(409, 'path-taken', 'This set already holds a file at that path.');
        case 'operation-reused': return fail(409, 'operation-reused', 'This upload id was already used for a different file.');
      }
      await declareOriginal(a, d.upload);
      return json(own.repeated ? 200 : 201, { operationId: d.upload.operationId, stage: 'received', path: d.upload.path, size: d.upload.size });
    }),

    /** PUT /client/intake/[caseId]/sets/[setId]/files/[operationId]: one declared file's exact bytes; stores it, never finalizes it. */
    uploadSetFile: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/pdf' });
      const setId = setIdOf(r), operationId = operationOf(r);
      const u = await storage(a.repository.upload({ ...a.scope, operationId }));
      if (!u || (await storage(a.repository.setOf({ ...a.scope, operationId }))) !== setId) return fail(404, 'not-declared', 'Declare the file in this set before sending it.');
      if (u.size > a.budget.maxFileBytes) return fail(413, 'too-large', 'The file is larger than this deployment accepts.');
      // Once stored the bytes were verified and acknowledged; a retry is answered from the durable state without reading the body.
      if (u.state !== 'received') return json(200, fileView(u));
      await put(a, operationId, await store(r, u));
      return json(201, fileView({ ...u, state: 'stored' }));
    }),

    /**
     * POST /client/intake/[caseId]/sets/[setId]/seal: the client's digest of its file list (filesSha256). The first call checks
     * the set is complete and the digest is the server's own, then records the revision; every call finalizes a bounded step of
     * originals. 202 means call again; 201 sealed by this call; 200 already sealed. A retry resumes from the durable state.
     */
    sealSet: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, { contentType: 'application/json' });
      const setId = setIdOf(r);
      const { filesSha256 } = await jsonBody(r, a.budget.maxMetadataBytes, 'filesSha256');
      if (typeof filesSha256 !== 'string' || !SHA.test(filesSha256)) return fail(422, 'invalid-declaration', 'The SHA-256 is invalid.');
      const scope = { ...a.scope, setId };
      let s = await setOrNotFound(a, setId);
      if (s.state === 'open') {
        const files = await storage(a.repository.setFiles({ ...scope, after: null, limit: s.fileCount }));
        const stored = files.filter((f) => f.upload.state === 'stored');
        if (files.length !== s.fileCount || stored.length !== s.fileCount || stored.reduce((n, f) => n + f.upload.size, 0) !== s.totalBytes)
          return json(409, { code: 'set-incomplete', message: 'Every file of the set must be sent before it is sealed.', fileCount: s.fileCount, declared: s.declared, stored: s.stored });
        if ((await fileSetDigest(files.map((f) => f.upload))) !== filesSha256) return fail(409, 'manifest-mismatch', 'The file list does not match the files this set holds.');
        // The precommit: the revision and every file are durable before any original becomes visible.
        try { await a.repository.reserveSet({ ...scope, filesSha256, at: ports!.now().toISOString() }); }
        catch { return fail(503, 'manifest-unrecorded', 'The set could not be recorded yet. Try the seal again; no file needs to be sent again.'); }
        s = await setOrNotFound(a, setId);
      } else if (s.filesSha256 !== filesSha256) return fail(409, 'manifest-mismatch', 'The file list does not match the files this set holds.');
      if (s.state === 'sealed') return json(200, { set: setView(s) });

      const step = ports!.sealStep ?? SEAL_STEP, started = ports!.now().getTime();
      const pending = await storage(a.repository.setFiles({ ...scope, after: null, limit: Math.min(step.files, 90), state: 'reserved' }));
      const done: string[] = [];
      let bytes = 0, failure: unknown = null;
      for (const f of pending) {
        if (done.length > 0 && (bytes + f.upload.size > step.bytes || ports!.now().getTime() - started > step.ms)) break;
        try {
          const fin = await storage(a.originals.finalize({ caseId: a.caseId, operationId: f.upload.operationId }));
          if (fin.kind === 'refused') storeRefusal(fin);
        } catch (e) { failure = e; break; }
        done.push(f.upload.operationId);
        bytes += f.upload.size;
      }
      // Record what was finalized even when a later file failed. An unrecorded one is finalized again, idempotently, next time.
      if (done.length) await storage(a.repository.markSetFilesFinalized({ ...scope, operationIds: done }));
      if (failure) throw failure;
      s = await setOrNotFound(a, setId);
      if (s.finalized < s.fileCount) return json(202, { set: setView(s) });
      try { await a.repository.commitSet({ ...scope, at: ports!.now().toISOString() }); }
      catch { return fail(503, 'manifest-unrecorded', 'The set could not be marked sealed yet. Try the seal again; no file needs to be sent again.'); }
      return json(201, { set: setView(await setOrNotFound(a, setId)) });
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

    /** GET /client/intake/[caseId]/submissions: every upload of the case, oldest first, with its stage, and whether this reader may upload when the deployment can say. */
    list: (r: IntakeRequest) => handle(async () => {
      const a = await admit(r, null);
      const rows = await storage(a.repository.list(a.scope));
      const sets = await storage(a.repository.sets(a.scope));
      // Advisory and unaudited: lets the page explain a missing upload grant. A fault or no port leaves the field out (unknown);
      // the page then offers no form, and the audited send still decides every upload.
      const canUpload = a.mayUpload ? await a.mayUpload({ principal: a.principal, clientId: a.scope.clientId, caseId: a.caseId }).catch(() => undefined) : undefined;
      return json(200, { submissions: rows.map((x) => view(x.upload, x.manifest)), sets: sets.map(setView), ...(typeof canUpload === 'boolean' ? { canUpload } : {}) });
    }),
  };
}
export type IntakeController = ReturnType<typeof createIntakeController>;
