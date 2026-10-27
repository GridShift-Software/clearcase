import { decodeUtf8Strict, isObject, parseStrictJson, type JsonObject, type JsonValue } from '../../case-package/strict-json.ts';
import type { CaseId, Identity } from '../../server/runtime/contracts.ts';
import { codeOf } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { readAtMost } from '../../submissions/body.ts';
import { packagePathOk } from './package.ts';
import { base64Length, decodeBase64Strict } from './staging/base64.ts';
import type { StagedRefusalCode } from './staging/service.ts';
import type { AdmittedOperator, NativeResultsImport, RefusalCode } from './service.ts';

/** What one request carries: the request, its URL, the route params and the request's identity (the existing contract). */
export interface NativeRequest { request: Request; url: URL; params: Partial<Record<'caseId' | 'candidateId' | 'operationId', string>>; identity: Identity }

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const fail = (status: number, code: string, message: string) => json(status, { code, message }, status === 503 ? { 'retry-after': '2' } : {});
class Refusal { readonly response: Response; constructor(response: Response) { this.response = response; } }
const refuse = (status: number, code: string, message: string): never => { throw new Refusal(fail(status, code, message)); };

const REFUSAL: Record<RefusalCode, [number, string]> = {
  'invalid-request': [422, 'The request is not valid.'],
  'package-invalid': [422, 'The package bytes do not verify.'],
  'wrong-case': [422, 'The package names another case.'],
  'validator-refused': [422, 'The package validator refused this package.'],
  'invalid-correction': [422, 'The correction is not allowed.'],
  'no-change': [422, 'The correction changes nothing.'],
  'operation-reused': [409, 'This operation id was already used for a different request.'],
  'submission-not-finalized': [409, 'The submission is not finalized.'],
  'candidate-exists': [409, 'A candidate of this results version already exists.'],
  'superseded': [409, 'Only the current candidate is corrected.'],
  'submission-changed': [409, 'The submission no longer matches the link.'],
  'submission-not-found': [404, 'No such finalized submission in this case.'],
  'base-not-found': [404, 'Not found.'],
  'stager-identity-mismatch': [502, 'The stager reported an identity other than the supplied package\'s.'],
  'over-budget': [413, 'This import is more work than one request on this deployment may do.'],
};

const STAGED_REFUSAL: Record<StagedRefusalCode, [number, string]> = {
  'invalid-request': [422, 'The request is not valid.'],
  'package-invalid': [422, 'The package manifest does not verify.'],
  'wrong-case': [422, 'The package names another case.'],
  'too-large': [413, 'The package is larger than this deployment accepts.'],
  'operation-reused': [409, 'This operation id was already used for a different request.'],
  'session-not-found': [404, 'No staged import was opened under this operation id.'],
  'file-not-in-manifest': [422, 'A file is not listed in the manifest.'],
  'file-mismatch': [422, 'A file does not match the manifest. Nothing from this batch was kept.'],
  'batch-too-large': [413, 'This batch is more than one request may carry.'],
  'incomplete': [409, 'The staged import is missing files.'],
  'over-budget': [413, 'This is more work than one request on this deployment may do.'],
  'submission-not-found': [404, 'No such finalized submission in this case.'],
  'submission-not-finalized': [409, 'The submission is not finalized.'],
  'session-expired': [410, 'The staged files of this import were deleted.'],
  'not-finished': [409, 'The import has no candidate yet and is still inside its time to live.'],
  'busy': [409, 'Another request is running a step of this import. Try again shortly.'],
  'staging-quota': [409, 'Staged imports on this deployment hold all the space they may. Finish or sweep one, then open again.'],
};

function authorityRefusal(e: unknown, access: 'read' | 'write'): never {
  const code = codeOf(e);
  if (code === 'unauthenticated' || code === 'invalid-session') refuse(401, 'unauthenticated', 'Sign in to continue.');
  if (code === 'wrong-client') refuse(401, 'wrong-client', 'This session belongs to another client. Sign in for this client.');
  if (code === 'forbidden' || code === 'not-found') {
    if (access === 'read') refuse(404, 'not-found', 'Not found.');
    refuse(403, 'forbidden', 'You cannot import results for this case.');
  }
  return refuse(503, 'identity-unavailable', 'Sign-in is unavailable. Try again shortly.');
}

/** The operator routes' controller. With a null service every route answers 503; nothing here defaults to an allow. */
export function createNativeImportController(service: NativeResultsImport | null) {
  async function admit(r: NativeRequest, access: 'read' | 'write', contentType: string | null) {
    if (access === 'write') {
      // The hosted entry refuses a cross-origin write before routing; this controller refuses it again rather than rely on it.
      if (r.request.headers.get('origin') !== r.url.origin) refuse(403, 'cross-origin', 'Cross-origin writes are refused.');
      if ((r.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== contentType) refuse(415, 'unsupported-media-type', `Send ${contentType}.`);
    }
    if (!service) return refuse(503, 'import-unavailable', 'Results import is not available on this deployment yet.');
    const raw = r.params.caseId;
    if (!raw || !PART.test(raw)) refuse(404, 'not-found', 'Not found.');
    const caseId = id('case', raw!) as CaseId;
    try { return { caseId, who: await service.admit({ identity: r.identity, caseId, access }), service }; } catch (e) { return authorityRefusal(e, access); }
  }
  const handle = (work: () => Promise<Response>) => work().catch((e) => {
    if (e instanceof Refusal) return e.response;
    const code = codeOf(e);
    if (code === 'integrity') return fail(503, 'integrity', 'A stored record failed its integrity check. Nothing was changed.');
    if (code === 'audit-unavailable') return fail(503, 'audit-unavailable', 'The audit log is unavailable. Try again with the same operation id; the work is not repeated.');
    if (code === 'correction-unavailable') return fail(503, 'correction-unavailable', 'Corrections are not available on this deployment yet.');
    if (code === 'forbidden') return fail(403, 'forbidden', 'You cannot import results for this case.');
    return fail(503, 'storage-unavailable', 'Storage is unavailable. Try again with the same operation id.');
  });

  /** One bounded JSON object, strictly parsed (duplicate keys, nesting and bad UTF-8 are refused). */
  async function body(r: NativeRequest, svc: NativeResultsImport, keys: string): Promise<JsonObject> {
    const b = await readAtMost(r.request.body, svc.budget.maxRequestBytes);
    if (b.kind === 'incomplete') return refuse(400, 'incomplete-body', 'The request was interrupted. Send it again.');
    if (b.kind !== 'ok') return refuse(413, 'too-large', 'The request is larger than this deployment accepts.');
    let v: JsonValue;
    try { v = parseStrictJson(decodeUtf8Strict(b.bytes)); } catch { return refuse(422, 'invalid-request', 'Send one strict JSON object.'); }
    if (!isObject(v) || Object.keys(v).sort().join() !== keys) return refuse(422, 'invalid-request', 'The request has missing or unknown fields.');
    return v;
  }
  const opId = (v: JsonValue | undefined) => (typeof v === 'string' && OPERATION.test(v) ? v : refuse(422, 'invalid-request', 'The operation id is invalid.'));
  const view = (status: number, repeated: boolean, candidate: unknown) => json(status, { kind: 'linked', repeated, candidate });
  const result = (o: Awaited<ReturnType<NativeResultsImport['importPackage']>>) => {
    if (o.kind === 'linked') return view(o.repeated ? 200 : 201, o.repeated, o.candidate);
    if (o.kind === 'unlinked') return json(422, { code: 'unlinked', message: 'The candidate is staged privately and is not linked to the submission.', resultsVersion: o.resultsVersion, reasons: o.reasons });
    const [status, message] = REFUSAL[o.code];
    return json(status, { code: o.code, message, detail: o.detail });
  };

  const staged = (svc: NativeResultsImport) => svc.staged ?? refuse(503, 'import-unavailable', 'The chunked import is not available on this deployment yet.');
  const stagedResult = (o: { kind: 'refused'; code: StagedRefusalCode; detail: readonly string[] } | { kind: string }, status = 200) => {
    if (o.kind === 'refused') { const r = o as { code: StagedRefusalCode; detail: readonly string[] }; const [code, message] = STAGED_REFUSAL[r.code]; return json(code, { code: r.code, message, detail: r.detail }); }
    return json(status, o);
  };
  const operationParam = (r: NativeRequest) => (r.params.operationId && OPERATION.test(r.params.operationId) ? r.params.operationId : refuse(404, 'not-found', 'Not found.'));

  return {
    /**
     * The chunked import, for packages the one-request import cannot carry. POST .../imports/staged opens it with the manifest;
     * POST .../imports/staged/[operationId]/files sends a bounded batch of files (path to base64), each checked against the manifest;
     * GET .../imports/staged/[operationId] says what is still missing; POST .../imports/staged/[operationId]/complete links the
     * verified package exactly as the one-request import does.
     */
    openStaged: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'write', 'application/json');
      const b = await body(r, a.service, 'manifest,operationId,submissionRevisionId');
      const operationId = opId(b.operationId);
      const rev = b.submissionRevisionId;
      if (typeof rev !== 'string' || !PART.test(rev)) return refuse(422, 'invalid-request', 'The submission revision id is invalid.');
      if (typeof b.manifest !== 'string' || !b.manifest.isWellFormed()) return refuse(422, 'invalid-request', 'manifest must be the text of manifest.json.');
      return stagedResult(await staged(a.service).open(a.who, { operationId, submissionRevisionId: rev, manifest: new TextEncoder().encode(b.manifest) }), 201);
    }),

    putStaged: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'write', 'application/json');
      const svc = staged(a.service);
      const operationId = operationParam(r);
      const b = await body(r, a.service, 'files');
      if (!isObject(b.files)) return refuse(422, 'invalid-request', 'files must be an object of path to base64.');
      const entries = Object.entries(b.files);
      if (entries.length < 1 || entries.length > svc.bounds.maxBatchFiles) return refuse(413, 'too-large', 'A batch carries between one and the stated number of files.');
      // Sizes first, from the text, so nothing is decoded that the batch may not carry.
      let total = 0;
      for (const [path, text] of entries) {
        const n = typeof text === 'string' ? base64Length(text) : null;
        if (n === null) return refuse(422, 'invalid-request', 'Every file must be canonical padded base64 text.');
        if (!packagePathOk(path)) return refuse(422, 'package-invalid', 'A package path is not a safe relative path.');
        total += n;
        if (total > svc.bounds.maxBatchBytes) return refuse(413, 'too-large', 'The batch is larger than one request may carry.');
      }
      const files = new Map<string, Uint8Array>();
      for (const [path, text] of entries) {
        const bytes = decodeBase64Strict(text as string);
        if (!bytes) return refuse(422, 'invalid-request', 'Every file must be canonical padded base64 text.');
        files.set(path, bytes);
      }
      return stagedResult(await svc.put(a.who, { operationId, files }));
    }),

    statusStaged: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'read', null);
      return stagedResult(await staged(a.service).status(a.who, { operationId: operationParam(r) }));
    }),

    completeStaged: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'write', 'application/json');
      const svc = staged(a.service);
      const operationId = operationParam(r);
      await body(r, a.service, '');
      const out = await svc.complete(a.who, { operationId });
      // Still staging: the work is half done and durable; call complete again. Every other answer is final.
      if (out.kind === 'staging') return json(202, out);
      // A refusal only the staged steps raise has its own table; the rest are the one-request import's and answer as it does.
      return out.kind === 'refused' && !(out.code in REFUSAL) ? stagedResult(out as never) : result(out as never);
    }),

    /** POST .../imports/staged/[operationId]/sweep: one bounded step of deleting a finished or abandoned import's staged objects. */
    sweepStaged: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'write', 'application/json');
      const operationId = operationParam(r);
      await body(r, a.service, '');
      return stagedResult(await staged(a.service).sweep(a.who, { operationId }));
    }),

    /**
     * POST .../imports/staged/sweep: the drain. The same step for the session of the case that is due next: a sweep under way, a finished
     * import, or one idle past its time to live. Call it until `operationId` is null.
     */
    sweepExpiredStaged: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'write', 'application/json');
      await body(r, a.service, '');
      return stagedResult(await staged(a.service).sweepExpired(a.who));
    }),

    /** POST /operator/results/[caseId]/imports: one bounded JSON request with the package files as UTF-8 text. */
    importPackage: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'write', 'application/json');
      const svc = a.service, budget = svc.budget;
      const b = await body(r, svc, 'files,operationId,submissionRevisionId');
      const operationId = opId(b.operationId);
      const rev = b.submissionRevisionId;
      if (typeof rev !== 'string' || !PART.test(rev)) return refuse(422, 'invalid-request', 'The submission revision id is invalid.');
      if (!isObject(b.files)) return refuse(422, 'invalid-request', 'files must be an object of path to text.');
      const entries = Object.entries(b.files);
      if (entries.length > budget.maxFiles) return refuse(413, 'too-large', 'The package has more files than this deployment accepts.');
      const files = new Map<string, Uint8Array>();
      let total = 0;
      const encoder = new TextEncoder();
      for (const [path, text] of entries) {
        if (typeof text !== 'string' || !text.isWellFormed()) return refuse(422, 'invalid-request', 'Every package file must be well-formed UTF-8 text.');
        const bytes = encoder.encode(text);
        if (bytes.byteLength > budget.maxFileBytes) return refuse(413, 'too-large', 'A package file is larger than this deployment accepts.');
        total += bytes.byteLength;
        if (total > budget.maxPackageBytes) return refuse(413, 'too-large', 'The package is larger than this deployment accepts.');
        if (!packagePathOk(path)) return refuse(422, 'package-invalid', 'A package path is not a safe relative path.');
        files.set(path, bytes);
      }
      return result(await svc.importPackage(a.who, { operationId, submissionRevisionId: rev, files }));
    }),

    /** POST /operator/results/[caseId]/candidates/[candidateId]/corrections: replace the data of existing authored datasets. */
    correct: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'write', 'application/json');
      const candidateId = r.params.candidateId;
      if (!candidateId || !PART.test(candidateId)) return refuse(404, 'not-found', 'Not found.');
      const b = await body(r, a.service, 'operationId,reason,replacements');
      const operationId = opId(b.operationId);
      const reason = b.reason;
      if (typeof reason !== 'string' || !reason.isWellFormed() || reason.trim().length === 0 || reason.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) return refuse(422, 'invalid-request', 'A short plain-text reason is required.');
      const reps = b.replacements;
      if (!Array.isArray(reps) || reps.length < 1 || reps.length > 8) return refuse(422, 'invalid-request', 'Send one to eight replacements.');
      const replacements: { key: string; data: JsonValue }[] = [];
      for (const x of reps) {
        if (!isObject(x) || Object.keys(x).sort().join() !== 'data,key' || typeof x.key !== 'string' || x.key.length > 64) return refuse(422, 'invalid-request', 'Each replacement is {key, data}.');
        replacements.push({ key: x.key, data: x.data });
      }
      return result(await a.service.correct(a.who, { operationId, candidateId, reason, replacements }));
    }),

    /** GET /operator/results/[caseId]/candidates/[candidateId]. */
    read: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'read', null);
      const candidateId = r.params.candidateId;
      if (!candidateId || !PART.test(candidateId)) return refuse(404, 'not-found', 'Not found.');
      const c = await a.service.readCandidate(a.who as AdmittedOperator, candidateId);
      return c ? json(200, c) : fail(404, 'not-found', 'Not found.');
    }),

    /** GET /operator/results/[caseId]/candidates. */
    list: (r: NativeRequest) => handle(async () => {
      const a = await admit(r, 'read', null);
      return json(200, { candidates: await a.service.listCandidates(a.who) });
    }),
  };
}
export type NativeImportController = ReturnType<typeof createNativeImportController>;
