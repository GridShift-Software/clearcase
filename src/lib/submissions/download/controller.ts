import type { AssetRef, AuditEvent, CaseId, Identity, IdentityState, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { codeOf } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { revisionIdOf } from '../repository.ts';
import type { SubmissionFile, SubmissionManifest, UploadRecord } from '../ports.ts';
import { digest } from '../../server/runtime/data.ts';
import type { OperatorDownloadPorts } from './ports.ts';

/** What one operator request carries: the request, its URL, the route params and the request's identity (the existing contract). */
export interface OperatorRequest { request: Request; url: URL; params: Partial<Record<'caseId' | 'operationId', string>>; identity: Identity }

/**
 * One finalized submission as the operator sees it. It names the exact manifest (and its digest) and the path that downloads
 * the one PDF. It carries no processing state: nothing here claims that anyone has started, claimed or finished the case.
 */
export interface OperatorSubmissionView {
  operationId: string; revisionId: string; sequence: number; caseId: string; clientId: string;
  manifest: SubmissionManifest;
  /** SHA-256 of the exact bytes the manifest route serves. */
  manifestSha256: string; manifestHref: string; downloadHref: string;
  files: { path: string; filename: string; mediaType: string; size: number; sha256: string; downloadHref: string }[];
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const RANGE = /^bytes=(\d{1,15}-\d{0,15}|-\d{1,15})$/;
const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/;
const PRIVATE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...PRIVATE, 'content-type': 'application/json; charset=utf-8', ...extra } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { code, message, ...extra }, status === 503 ? { 'retry-after': '2' } : {});
class Refusal { readonly response: Response; constructor(response: Response) { this.response = response; } }
const refuse = (status: number, code: string, message: string, extra?: Record<string, unknown>): never => { throw new Refusal(fail(status, code, message, extra)); };
/** The one answer for an invalid id, an unknown case, a case without the capability or original access, and an unknown submission. */
const notFound = (): never => refuse(404, 'not-found', 'Not found.');

function authorityRefusal(e: unknown): never {
  const code = codeOf(e);
  if (code === 'unauthenticated' || code === 'invalid-session') refuse(401, 'unauthenticated', 'Sign in to continue.');
  if (code === 'wrong-client') refuse(401, 'wrong-client', 'This session belongs to another client. Sign in for this client.');
  if (code === 'forbidden' || code === 'not-found') notFound();
  if (code === 'audit-unavailable') refuse(503, 'audit-unavailable', 'The audit log is unavailable, so nothing was released. Try again shortly.');
  return refuse(503, 'identity-unavailable', 'Sign-in is unavailable. Try again shortly.');
}
// A fault of the stored original, after authority: truthful, and it names nothing beyond this submission.
function assetRefusal(e: unknown): never {
  const code = codeOf(e);
  if (code === 'missing-original') refuse(410, 'missing-original', 'This original is no longer available.');
  if (code === 'changed-original') refuse(410, 'changed-original', 'This original failed its integrity check.');
  if (code === 'forbidden' || code === 'not-found') notFound();
  if (code === 'unauthenticated' || code === 'invalid-session' || code === 'wrong-client') authorityRefusal(e);
  if (code === 'audit-unavailable') authorityRefusal(e);
  if (code === 'asset-unavailable' || code === 'storage-unavailable') refuse(503, 'asset-unavailable', 'Originals are unavailable. Try again shortly.');
  throw e;
}

const hex = (bytes: Uint8Array) => [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
const base64OfHex = (h: string) => btoa(String.fromCharCode(...h.match(/../g)!.map((x) => parseInt(x, 16))));
/** The manifest's exact served bytes: a fixed key order, so the same stored manifest always has the same digest. */
const manifestBytes = (m: SubmissionManifest) => new TextEncoder().encode(JSON.stringify({
  format: m.format, clientId: m.clientId, caseId: m.caseId, revisionId: m.revisionId, sequence: m.sequence, operationId: m.operationId, finalizedAt: m.finalizedAt,
  files: m.files.map((f) => ({ path: f.path, filename: f.filename, mediaType: f.mediaType, size: f.size, sha256: f.sha256, assetId: f.assetId })),
}));
const pct = (s: string) => [...new TextEncoder().encode(s)].map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
/** A header-safe attachment name from the recorded file name: its last path segment only, an ASCII fallback and the exact UTF-8 name. */
function disposition(filename: string): string {
  let name = (filename.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120);
  if (!name) name = 'submission.pdf';
  if (!/\.pdf$/i.test(name)) name = `${name}.pdf`;
  return `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"; filename*=UTF-8''${pct(name)}`;
}

/** Exactly `expected` bytes of `body`, pulled on demand: one more or one fewer byte errors the stream instead of ending it normally. */
function exactly(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const step = await reader.read();
      if (step.done) { if (sent === expected) c.close(); else c.error(new Error('the original ended before its recorded size')); return; }
      if (sent + step.value.byteLength > expected) { await reader.cancel().catch(() => undefined); c.error(new Error('the original is longer than its recorded size')); return; }
      sent += step.value.byteLength;
      c.enqueue(step.value);
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
}

/** The operator download's HTTP controller: list, one submission, its manifest and its PDF. */
export function createOperatorDownloadController(ports: OperatorDownloadPorts | null) {
  const hrefOf = (caseId: string, operationId: string, tail = '') => `/operator/submissions/${encodeURIComponent(caseId)}/finalized/${encodeURIComponent(operationId)}${tail}`;

  // Order: configured ports, id syntax, verified identity of this client, then the explicit capability AND original access.
  // Nothing before the return reads a row, a body or an object.
  async function admit(r: OperatorRequest, needsOperation: boolean) {
    if (!ports || !ports.authorizeOperate || !ports.repository || !ports.assets || !ports.audit) return refuse(503, 'operator-download-unavailable', 'Operator downloads are not available on this deployment yet.');
    const raw = r.params.caseId;
    if (!raw || !PART.test(raw)) notFound();
    const operationId = r.params.operationId;
    if (needsOperation && (!operationId || !OPERATION.test(operationId))) notFound();
    const caseId = id('case', raw!) as CaseId;
    const who = r.identity;
    if (who.kind !== 'verified') refuse(401, 'unauthenticated', 'Sign in to continue.');
    if (who.clientId !== ports.clientId) refuse(401, 'wrong-client', 'This session belongs to another client. Sign in for this client.');
    const { principal, sessionId } = who as { principal: Principal; sessionId: SessionId };
    // Operators are the service team's staff principals. A client user never operates, whatever else says yes.
    if (principal.kind !== 'staff') notFound();
    try {
      await who.checkRevocation();
      await ports.authorizeOperate({ principal, sessionId, caseId, capability: 'operate' });
      await who.authorize({ caseId, operation: 'read-original' });
    } catch (e) { authorityRefusal(e); }
    const actor: IdentityState = { kind: 'verified', principal: { issuer: principal.issuer, subject: principal.subject, kind: principal.kind }, sessionId };
    return { caseId, operationId: operationId ?? '', actor, repository: ports.repository, assets: ports.assets, audit: ports.audit, scope: { clientId: ports.clientId, caseId } };
  }
  type Admitted = Awaited<ReturnType<typeof admit>>;
  const event = (a: Admitted, action: string, object: AuditEvent['object'], outcome: AuditEvent['outcome']): AuditEvent =>
    ({ eventId: ports!.newEventId?.() ?? crypto.randomUUID(), actor: a.actor, action, object, version: null, outcome, at: ports!.now().toISOString() });
  /** The audit record of a release, appended before anything is released. With the log unavailable nothing is released. */
  const release = (a: Admitted, action: string, object: AuditEvent['object']) =>
    a.audit.append(event(a, action, object, 'succeeded')).catch(() => refuse(503, 'audit-unavailable', 'The audit log is unavailable, so nothing was released. Try again shortly.'));
  const failed = (a: Admitted, action: string, object: AuditEvent['object']) => a.audit.append(event(a, action, object, 'failed')).catch(() => undefined);
  const storage = <T>(work: Promise<T>): Promise<T> => work.catch((e) => {
    if (codeOf(e) === 'forbidden') notFound();
    return refuse(503, 'storage-unavailable', 'Submission storage is unavailable. Try again shortly.');
  });
  const handle = (work: () => Promise<Response>) => work().catch((e) => { if (e instanceof Refusal) return e.response; throw e; });

  // A recorded submission must agree with itself and with this request before any of it is shown: the manifest names this
  // client, case, operation and revision, and exactly one PDF whose path, size, digest and asset are the upload's own.
  function consistent(a: Admitted, u: UploadRecord, m: SubmissionManifest | null): { manifest: SubmissionManifest; file: SubmissionFile } {
    const bad = () => refuse(503, 'submission-inconsistent', 'This submission\'s records do not agree, so it is not served. Tell the service team.');
    if (!m || m.format !== 'clearcase.submission-manifest/1' || m.clientId !== a.scope.clientId || m.caseId !== a.caseId || m.operationId !== u.operationId || m.revisionId !== revisionIdOf(u.operationId)) return bad();
    if (m.files.length !== 1) return bad();
    const f = m.files[0];
    if (f.assetId !== u.assetId || f.path !== u.path || f.size !== u.size || f.sha256 !== u.sha256 || f.mediaType !== 'application/pdf') return bad();
    return { manifest: m, file: f };
  }
  async function viewOf(a: Admitted, manifest: SubmissionManifest, file: SubmissionFile): Promise<OperatorSubmissionView> {
    const href = hrefOf(a.caseId, manifest.operationId, '/download');
    return {
      operationId: manifest.operationId, revisionId: manifest.revisionId, sequence: manifest.sequence, caseId: manifest.caseId, clientId: manifest.clientId, manifest,
      manifestSha256: await digest(manifestBytes(manifest)), manifestHref: hrefOf(a.caseId, manifest.operationId, '/manifest'), downloadHref: href,
      files: [{ path: file.path, filename: file.filename, mediaType: file.mediaType, size: file.size, sha256: file.sha256, downloadHref: href }],
    };
  }
  // The one finalized submission of this case named by the request. An unknown id is the uniform not-found; an upload that is
  // not yet final is refused truthfully (the caller is already authorized for this case).
  async function finalized(a: Admitted) {
    const u = await storage(a.repository.upload({ ...a.scope, operationId: a.operationId }));
    if (!u) return notFound();
    if (u.state !== 'finalized') return refuse(409, 'not-finalized', 'This upload is not a finalized submission yet, so it is not available.', { stage: u.state === 'received' ? 'received' : 'stored-not-finalized' });
    const { manifest, file } = consistent(a, u, await storage(a.repository.revision({ ...a.scope, operationId: a.operationId })));
    return { manifest, file };
  }
  const identityHeaders = (a: Admitted, m: SubmissionManifest, f: SubmissionFile) => ({
    'x-clearcase-case': a.caseId, 'x-clearcase-submission': m.operationId, 'x-clearcase-revision': m.revisionId, 'x-clearcase-sha256': f.sha256,
  });

  return {
    /** GET /operator/submissions/[caseId]/finalized: the case's finalized submissions, by sequence; pending uploads are only counted. */
    list: (r: OperatorRequest) => handle(async () => {
      const a = await admit(r, false);
      const rows = await storage(a.repository.list(a.scope));
      const done = rows.filter((x) => x.upload.state === 'finalized').map((x) => consistent(a, x.upload, x.manifest)).sort((x, y) => x.manifest.sequence - y.manifest.sequence);
      const submissions = await Promise.all(done.map((x) => viewOf(a, x.manifest, x.file)));
      await release(a, 'operator.submission.list', { kind: 'case', id: a.caseId, caseId: a.caseId });
      return json(200, { submissions, pendingCount: rows.length - done.length });
    }),

    /** GET .../finalized/[operationId]: the manifest, its digest and the paths to the manifest and the PDF. */
    read: (r: OperatorRequest) => handle(async () => {
      const a = await admit(r, true);
      const { manifest, file } = await finalized(a);
      const view = await viewOf(a, manifest, file);
      await release(a, 'operator.submission.read', { kind: 'submission', id: manifest.operationId, caseId: a.caseId });
      return json(200, view);
    }),

    /** GET .../finalized/[operationId]/manifest: the exact immutable manifest bytes as a download-safe attachment. */
    manifest: (r: OperatorRequest) => handle(async () => {
      const a = await admit(r, true);
      const { manifest, file } = await finalized(a);
      const bytes = manifestBytes(manifest), sha = await digest(bytes);
      await release(a, 'operator.submission.manifest', { kind: 'submission', id: manifest.operationId, caseId: a.caseId });
      return new Response(bytes, { status: 200, headers: {
        ...PRIVATE, ...identityHeaders(a, manifest, file), 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes.byteLength),
        'content-disposition': `attachment; filename="submission-${manifest.operationId}.manifest.json"`, 'x-clearcase-manifest-sha256': sha, etag: `"sha256-${sha}"`,
      } });
    }),

    /** GET or HEAD .../finalized/[operationId]/download: the complete PDF (or one range), integrity-bound to the manifest. */
    download: (r: OperatorRequest) => handle(async () => {
      const a = await admit(r, true);
      const { manifest, file } = await finalized(a);
      const asset: AssetRef = { kind: 'original', caseId: a.caseId, assetId: file.assetId };
      const object = { kind: 'submission', id: manifest.operationId, caseId: a.caseId };
      // The stored original must be the very file the manifest records, before anything is released.
      const meta = await a.assets.metadata({ asset }).catch(assetRefusal);
      if (meta.size !== file.size || meta.sha256 !== file.sha256 || meta.mediaType !== 'application/pdf') return refuse(410, 'changed-original', 'This original failed its integrity check.');
      await release(a, 'operator.submission.download', object);
      const method = r.request.method === 'HEAD' ? 'HEAD' : 'GET';
      const wanted = r.request.headers.get('range');
      const range = wanted !== null && wanted.length <= 64 && RANGE.test(wanted) ? wanted : null;
      const ifRange = range !== null ? r.request.headers.get('if-range') : null;
      const upstream = await a.assets.get({ asset, request: { method, range, ifRange: ifRange !== null && ifRange.length <= 128 ? ifRange : null } }).catch(async (e) => { await failed(a, 'operator.submission.download', object); return assetRefusal(e); });
      const contradict = async (): Promise<never> => { await upstream.body?.cancel().catch(() => undefined); await failed(a, 'operator.submission.download', object); return refuse(503, 'asset-unavailable', 'Originals are unavailable. Try again shortly.'); };
      const headers: Record<string, string> = {
        ...PRIVATE, ...identityHeaders(a, manifest, file), 'content-type': 'application/pdf', 'content-disposition': disposition(file.filename), 'accept-ranges': 'bytes',
        'content-security-policy': "sandbox; default-src 'none'", 'repr-digest': `sha-256=:${base64OfHex(file.sha256)}:`,
        link: `<${hrefOf(a.caseId, manifest.operationId, '/manifest')}>; rel="describedby"; type="application/json"`, etag: upstream.headers.get('etag') ?? `"${file.sha256}"`,
      };
      if (upstream.status === 416) {
        await upstream.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${file.size}` } });
      }
      let expected: number;
      if (upstream.status === 200 && range === null) expected = file.size;
      else if (upstream.status === 206 && range !== null) {
        const m = CONTENT_RANGE.exec(upstream.headers.get('content-range') ?? '');
        if (!m) return contradict();
        const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (total !== file.size || start > end || end >= file.size) return contradict();
        expected = end - start + 1;
        headers['content-range'] = `bytes ${start}-${end}/${total}`;
      } else if (upstream.status === 200 && range !== null) expected = file.size; // a service that ignored the range answers the whole file
      else return contradict();
      const declared = upstream.headers.get('content-length');
      if (declared !== null && declared !== String(expected)) return contradict();
      headers['content-length'] = String(expected);
      if (method === 'HEAD') { await upstream.body?.cancel().catch(() => undefined); return new Response(null, { status: upstream.status, headers }); }
      if (!upstream.body) return contradict();
      return new Response(exactly(upstream.body, expected), { status: upstream.status, headers });
    }),
  };
}
export type OperatorDownloadController = ReturnType<typeof createOperatorDownloadController>;
