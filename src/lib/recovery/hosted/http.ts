import { decodeUtf8Strict, isObject, parseStrictJson, type JsonObject, type JsonValue } from '../../case-package/strict-json.ts';
import type { Identity } from '../../server/runtime/contracts.ts';
import { codeOf } from '../../server/runtime/errors.ts';
import { readAtMost } from '../../submissions/body.ts';
import { ID, SHA } from './bytes.ts';
import type { NativeRecoveryBinding } from './composition.ts';
import { exportNativeCase, type NativeExportRequest } from './export.ts';
import { verifyNativeExport } from './native-evidence.ts';
import { applyNativeRestore, planNativeRestore, type RestoreDeps } from './restore.ts';

/** What one request carries: the request, its URL, the route params and the request's identity (the existing contract). */
export interface RecoveryRequest { request: Request; url: URL; params: Partial<Record<'caseId', string>>; identity: Identity }

/** Commands are a handful of identifiers and digests; anything larger is not a command. */
export const MAX_COMMAND_BYTES = 2048;
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const fail = (status: number, code: string, message: string) => json(status, { code, message }, status === 503 ? { 'retry-after': '2' } : {});
class Refusal { readonly response: Response; constructor(response: Response) { this.response = response; } }
const refuse = (status: number, code: string, message: string): never => { throw new Refusal(fail(status, code, message)); };

/** Fixed text per core code; a provider message, key, stack or cause never reaches the response. */
const CODES: Record<string, [number, string]> = {
  'unauthenticated': [401, 'Sign in to continue.'],
  'invalid-session': [401, 'Sign in to continue.'],
  'wrong-client': [401, 'This session belongs to another client. Sign in for this client.'],
  'forbidden': [403, 'You cannot use recovery for this case.'],
  'not-found': [404, 'Not found.'],
  'foreign-input': [404, 'Not found.'],
  'invalid-request': [422, 'The request is not valid.'],
  'manifest-invalid': [422, 'The stored export manifest is not valid.'],
  'export-corrupt': [422, 'A stored export object failed its integrity check.'],
  'package-corrupt': [422, 'A results package failed its integrity check.'],
  'export-too-large': [422, 'The case is larger than this deployment exports.'],
  'export-incomplete': [409, 'The export is incomplete.'],
  'manifest-mismatch': [409, 'The stored manifest does not match the pinned digest.'],
  'export-exists': [409, 'This export id already exists.'],
  'export-raced': [409, 'The case changed during the export. Try again.'],
  'plan-mismatch': [409, 'The confirmed plan is not the current plan.'],
  'stale-state': [409, 'The restore target changed since the plan.'],
  'restore-conflict': [409, 'The restore target already holds different bytes.'],
  'target-not-empty': [409, 'The restore target is not empty.'],
  'target-not-isolated': [503, 'No isolated restore target is available.'],
  'restore-failed': [503, 'The restore did not complete. Verify the target before trying again with the same operation id.'],
  'audit-unavailable': [503, 'The audit log is unavailable. Nothing was read.'],
  'storage-unavailable': [503, 'Storage is unavailable. The outcome may be partial; plan again before retrying.'],
  'recovery-unavailable': [503, 'Recovery is not available on this deployment yet.'],
};

const ORIGIN = (r: RecoveryRequest, appOrigin: string | null) => {
  const origin = r.request.headers.get('origin');
  return origin !== null && origin === r.url.origin && (appOrigin === null || origin === appOrigin);
};
function sameSession(a: Identity, b: Identity): boolean {
  return a.kind === 'verified' && b.kind === 'verified' && a.clientId === b.clientId && a.sessionId === b.sessionId &&
    a.principal.issuer === b.principal.issuer && a.principal.subject === b.principal.subject && a.principal.kind === b.principal.kind;
}

type Field = 'exportId' | 'includeUserWork' | 'auditScope' | 'expectedManifestSha256' | 'confirmedPlanSha256' | 'operationId';
const FIELDS: Record<Field, (v: JsonValue) => boolean> = {
  exportId: (v) => typeof v === 'string' && ID.test(v),
  includeUserWork: (v) => typeof v === 'boolean',
  auditScope: (v) => v === 'case-audit/1' || v === 'none',
  expectedManifestSha256: (v) => typeof v === 'string' && SHA.test(v),
  confirmedPlanSha256: (v) => typeof v === 'string' && SHA.test(v),
  operationId: (v) => typeof v === 'string' && ID.test(v),
};

/** The four native /2 routes. Without a binding every route answers 503; nothing here supplies a default, a double or an allow. */
export function createRecoveryController(binding: NativeRecoveryBinding | null) {
  /** Method, origin, media and binding precede identity; identity and case precede the body; the body precedes every core call. */
  async function admit(r: RecoveryRequest, required: readonly Field[], optional: readonly Field[] = []) {
    if (r.request.method !== 'POST') refuse(405, 'method-not-allowed', 'Send POST.');
    if (!ORIGIN(r, binding?.appOrigin ?? null)) refuse(403, 'cross-origin', 'Cross-origin writes are refused.');
    if ((r.request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') refuse(415, 'unsupported-media-type', 'Send application/json.');
    if (!binding) refuse(503, 'recovery-unavailable', CODES['recovery-unavailable']![1]);
    const bound = binding!;
    const raw = r.params.caseId;
    if (!raw || !ID.test(raw) || raw !== bound.caseId) refuse(404, 'not-found', 'Not found.');
    if (r.identity.kind !== 'verified') refuse(401, 'unauthenticated', 'Sign in to continue.');
    if (!sameSession(r.identity, bound.deps.identity)) refuse(503, 'recovery-unavailable', CODES['recovery-unavailable']![1]);
    const declared = r.request.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_COMMAND_BYTES)) refuse(413, 'too-large', 'The request is larger than a recovery command.');
    const read = await readAtMost(r.request.body, MAX_COMMAND_BYTES);
    if (read.kind === 'incomplete') refuse(400, 'incomplete-body', 'The request was interrupted. Send it again.');
    if (read.kind !== 'ok') refuse(413, 'too-large', 'The request is larger than a recovery command.');
    let v: JsonValue;
    try { v = parseStrictJson(decodeUtf8Strict((read as { kind: 'ok'; bytes: Uint8Array }).bytes)); } catch { return refuse(422, 'invalid-request', 'Send one strict JSON object.'); }
    if (!isObject(v)) return refuse(422, 'invalid-request', 'Send one strict JSON object.');
    const body: JsonObject = v;
    const known = new Set<string>([...required, ...optional]);
    if (Object.keys(body).some((k) => !known.has(k)) || required.some((k) => !(k in body))) refuse(422, 'invalid-request', 'The request has missing or unknown fields.');
    for (const k of Object.keys(body)) if (!FIELDS[k as Field](body[k]!)) refuse(422, 'invalid-request', `${k} is not valid.`);
    return { body, deps: bound.deps, restore: bound.restore, caseId: bound.caseId };
  }
  const handle = (work: () => Promise<Response>) => work().catch((e) => {
    if (e instanceof Refusal) return e.response;
    const known = CODES[codeOf(e) ?? ''];
    return known ? fail(known[0], codeOf(e)!, known[1]) : fail(503, 'recovery-unavailable', CODES['recovery-unavailable']![1]);
  });
  const restoreDeps = (a: { deps: NativeRecoveryBinding['deps']; restore: NativeRecoveryBinding['restore'] }): RestoreDeps =>
    ({ ...a.deps, liveIsolationId: a.restore?.liveIsolationId ?? '', target: a.restore?.target ?? null });

  return {
    /** POST .../recovery/native/export: `{exportId, includeUserWork, auditScope?}` writes one /2 archive. */
    exportArchive: (r: RecoveryRequest) => handle(async () => {
      const a = await admit(r, ['exportId', 'includeUserWork'], ['auditScope']);
      const req: NativeExportRequest = { caseId: a.caseId, exportId: a.body.exportId as string, includeUserWork: a.body.includeUserWork as boolean };
      if ('auditScope' in a.body) req.auditScope = a.body.auditScope as 'case-audit/1' | 'none';
      const out = await exportNativeCase(a.deps, req);
      const m = out.manifest;
      return json(201, { kind: 'exported', format: m.format, exportId: m.exportId, caseId: m.caseId, createdAt: m.createdAt, manifestSha256: out.manifestSha256,
        evidence: { audit: m.evidence.audit, rows: m.evidence.rows, bytes: m.evidence.bytes, sha256: m.evidence.sha256 }, accounting: out.accounting });
    }),

    /** POST .../recovery/native/verify: re-reads the stored archive against the pinned manifest digest. */
    verify: (r: RecoveryRequest) => handle(async () => {
      const a = await admit(r, ['exportId', 'expectedManifestSha256']);
      const out = await verifyNativeExport(a.deps, { caseId: a.caseId, exportId: a.body.exportId as string, expectedManifestSha256: a.body.expectedManifestSha256 as string });
      return json(200, { kind: 'verified', format: out.manifest.format, exportId: out.manifest.exportId, caseId: out.manifest.caseId, manifestSha256: out.manifestSha256,
        verifiedBlobs: out.verifiedBlobs, accounting: out.accounting });
    }),

    /** POST .../recovery/native/plan: read-only restore plan into the isolated target. */
    plan: (r: RecoveryRequest) => handle(async () => {
      const a = await admit(r, ['exportId', 'expectedManifestSha256']);
      const plan = await planNativeRestore(restoreDeps(a), { caseId: a.caseId, exportId: a.body.exportId as string, expectedManifestSha256: a.body.expectedManifestSha256 as string });
      return json(200, { kind: 'planned', plan });
    }),

    /** POST .../recovery/native/apply: additive staging of the confirmed plan; never activates anything. */
    apply: (r: RecoveryRequest) => handle(async () => {
      const a = await admit(r, ['exportId', 'expectedManifestSha256', 'confirmedPlanSha256', 'operationId']);
      const report = await applyNativeRestore(restoreDeps(a), { caseId: a.caseId, exportId: a.body.exportId as string,
        expectedManifestSha256: a.body.expectedManifestSha256 as string, confirmedPlanSha256: a.body.confirmedPlanSha256 as string, operationId: a.body.operationId as string });
      return json(200, { kind: 'applied', report });
    }),
  };
}
export type RecoveryController = ReturnType<typeof createRecoveryController>;
