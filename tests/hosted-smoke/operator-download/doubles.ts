// UNIT TEST DOUBLES ONLY. The intake's SQLite D1 stand-in (reused read-only from the intake tests), an in-memory stand-in for
// the assets service and recording stand-ins for the capability and audit ports. They run the controller and the repository;
// they are not Cloudflare D1, not R2, not the GRS-115/118 adapter, not the tenancy authorizer, so nothing here is evidence of
// a real boundary. No production path can reach them.
import { createHash } from 'node:crypto';
import type { AssetMetadata, AssetRef, AuditEvent, ByteRequest, CaseId, ClientId, Identity, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { d1SubmissionRepository, type IntakeD1 } from '../../../src/lib/submissions/index.ts';
import type { SubmissionRepository } from '../../../src/lib/submissions/index.ts';
import { SqliteD1 } from '../intake/doubles.ts';
export { SqliteD1 };

export const CLIENT = id('client', 'client-a') as ClientId;
export const CASE_A = id('case', 'case-a') as CaseId;
export const CASE_B = id('case', 'case-b') as CaseId;
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const code = (c: string) => Object.assign(new Error(c), { code: c, retryable: false });
export const SESSION = id('session', '0b7c2f3e-1d2a-4c5b-8e9f-001122334455') as SessionId;

/** A synthetic PDF: header, a tiny body and the end-of-file marker. Not case material. */
export function syntheticPdf(tag = 'one', pad = 0): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% synthetic ClearCase operator fixture ${tag}\n${'x'.repeat(pad)}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}

export interface WhoOptions { kind?: 'verified' | 'anonymous'; principalKind?: Principal['kind']; clientId?: ClientId; readOriginal?: readonly CaseId[]; revoked?: boolean }
/** The request's identity: its own `read-original` access to the listed cases only. */
export function identity(o: WhoOptions = {}): Identity {
  const principal: Principal = { issuer: 'https://staff.issuer.test', subject: 'operator-1', kind: o.principalKind ?? 'staff' };
  const authorize: Identity['authorize'] = async (a) => { if (a.operation !== 'read-original' || !(o.readOriginal ?? [CASE_A]).includes(a.caseId)) throw code('forbidden'); };
  const checkRevocation = async () => { if (o.revoked) throw code('invalid-session'); };
  const base = { clientId: o.clientId ?? CLIENT, checkRevocation, authorize };
  return o.kind === 'anonymous' ? { ...base, kind: 'anonymous', principal: null, sessionId: null } : { ...base, kind: 'verified', principal, sessionId: SESSION };
}

/** The explicit `operate` capability: exactly the listed cases of the trusted client. */
export function operateAuthority(cases: readonly CaseId[], calls: unknown[] = []) {
  return async (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; capability: string }) => {
    calls.push(a);
    if (a.capability !== 'operate' || !cases.includes(a.caseId)) throw code('forbidden');
  };
}

export class MemoryAudit {
  readonly events: AuditEvent[] = [];
  order: string[] | null = null;
  failNext = false;
  async append(e: AuditEvent) {
    this.order?.push('audit');
    if (this.failNext) { this.failNext = false; throw code('audit-unavailable'); }
    this.events.push(structuredClone(e));
    return { eventId: e.eventId };
  }
}

export interface Tamper { extraBytes?: number; shortBytes?: number; status?: number; contentRange?: string; mediaType?: string; sha256?: string; size?: number; missing?: boolean }
/** The assets service, in memory: integrity-checked whole 200, one-range 206, 416, HEAD without a body; bytes stream in small chunks, pulled on demand. */
export class MemoryAssets {
  readonly objects = new Map<string, Uint8Array>();
  readonly names = new Map<string, string>();
  calls: string[] = [];
  requests: ByteRequest[] = [];
  pulled = 0;
  tamper: Tamper = {};
  order: string[] | null = null;
  key = (a: AssetRef) => `${a.caseId}/${a.assetId}`;
  async metadata({ asset }: { asset: AssetRef }): Promise<AssetMetadata> {
    this.calls.push('metadata');
    const b = this.objects.get(this.key(asset));
    if (!b || this.tamper.missing) throw code('missing-original');
    return { size: this.tamper.size ?? b.byteLength, sha256: (this.tamper.sha256 ?? sha(b)) as never, mediaType: this.tamper.mediaType ?? 'application/pdf', filename: this.names.get(this.key(asset)) ?? 'x.pdf', objectVersion: 'v1', etag: `"obj-${sha(b).slice(0, 12)}"` };
  }
  async get({ asset, request }: { asset: AssetRef; request: ByteRequest }): Promise<Response> {
    this.calls.push(`get:${request.method}`);
    this.order?.push('get');
    this.requests.push(request);
    const b = this.objects.get(this.key(asset));
    if (!b) throw code('missing-original');
    let start = 0, end = b.byteLength - 1, status = 200;
    const m = request.range ? /^bytes=(\d*)-(\d*)$/.exec(request.range) : null;
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, b.byteLength - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start >= b.byteLength || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${b.byteLength}` } });
      status = 206;
    }
    const slice = b.slice(start, end + 1);
    const headers: Record<string, string> = { etag: `"obj-${sha(b).slice(0, 12)}"`, 'content-length': String(slice.byteLength), 'content-type': 'application/pdf' };
    if (status === 206) headers['content-range'] = this.tamper.contentRange ?? `bytes ${start}-${end}/${b.byteLength}`;
    const out = this.tamper.extraBytes ? new Uint8Array([...slice, ...new Uint8Array(this.tamper.extraBytes).fill(0x41)]) : this.tamper.shortBytes ? slice.slice(0, slice.byteLength - this.tamper.shortBytes) : slice;
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    let at = 0;
    const body = new ReadableStream<Uint8Array>({ pull: (c) => { if (at >= out.byteLength) { c.close(); return; } const n = Math.min(out.byteLength, at + 8); this.pulled += n - at; c.enqueue(out.slice(at, n)); at = n; } }, { highWaterMark: 0 });
    return new Response(body, { status: this.tamper.status ?? status, headers });
  }
  links = undefined as never; availability = undefined as never; originals = undefined as never;
}

export type Stage = 'received' | 'stored' | 'reserved' | 'finalized';
export interface World {
  db: SqliteD1; repo: SubmissionRepository; assets: MemoryAssets; audit: MemoryAudit; operateCalls: unknown[]; repoCalls: string[];
  ports: Record<string, unknown>;
}
/** The ports of one deployment of client-a, with the operator holding the capability and original access on case-a only. */
export function world(o: { operate?: readonly CaseId[] } = {}): World {
  const db = new SqliteD1(['0001_submissions_intake.sql', '0002_submissions_file_sets.sql'].map((f) => new URL(`../../../src/lib/submissions/migrations/${f}`, import.meta.url).pathname));
  const repo = d1SubmissionRepository(db as unknown as IntakeD1);
  const repoCalls: string[] = [], operateCalls: unknown[] = [];
  const watched = new Proxy(repo, { get: (t, k: string) => (...a: unknown[]) => { repoCalls.push(k); return (t as never as Record<string, (...x: unknown[]) => unknown>)[k](...a); } }) as SubmissionRepository;
  const assets = new MemoryAssets(), audit = new MemoryAudit();
  const ports = { clientId: CLIENT, authorizeOperate: operateAuthority(o.operate ?? [CASE_A], operateCalls), repository: watched, assets, audit, now: () => new Date('2026-10-25T09:00:00.000Z'), newEventId: (() => { let n = 0; return () => `evt-${++n}`; })() };
  return { db, repo, assets, audit, operateCalls, repoCalls, ports };
}

let seq = 0;
export const opId = () => `op-${String(++seq).padStart(4, '0')}-0b7c2f3e1d2a4c5b`;
/** Drives the intake's own repository to the requested state and keeps the bytes in the assets stand-in. Returns the ids. */
export async function seed(w: World, o: { caseId?: CaseId; stage?: Stage; bytes?: Uint8Array; path?: string; filename?: string; operationId?: string } = {}) {
  const caseId = o.caseId ?? CASE_A, operationId = o.operationId ?? opId(), bytes = o.bytes ?? syntheticPdf(operationId);
  const path = o.path ?? 'docs/Claim File.pdf', filename = o.filename ?? path.split('/').pop()!, stage = o.stage ?? 'finalized';
  const assetId = `sub-${operationId}`, at = '2026-10-24T10:00:00.000Z', s = { clientId: CLIENT, caseId, operationId };
  await w.repo.declare({ clientId: CLIENT, caseId, operationId, assetId, path, filename, mediaType: 'application/pdf', size: bytes.byteLength, sha256: sha(bytes), principal: { issuer: 'https://client.issuer.test', subject: 'client-user' }, at });
  w.assets.objects.set(`${caseId}/${assetId}`, bytes);
  w.assets.names.set(`${caseId}/${assetId}`, filename);
  if (stage !== 'received') await w.repo.markStored({ ...s, at });
  if (stage === 'reserved') await w.repo.reserveRevision({ ...s, at });
  if (stage === 'finalized') await w.repo.commitRevision({ ...s, at });
  return { caseId, operationId, assetId, bytes, sha256: sha(bytes) };
}
