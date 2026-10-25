// UNIT TEST DOUBLES ONLY. A staff identity with a case-operate capability, a stager that runs the REAL case-package
// validator over a temporary case folder but stores nothing durable, a package reader over that memory, and an audit
// recorder. D1 is the node:sqlite stand-in of the intake tests. None of this is Cloudflare D1, R2, GRS-113/114/115/116,
// so a pass here is component evidence, not a hosted PASS. No production path can reach any of it.
import type { AuditEvent, CaseId, ClientId, Identity, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { d1SubmissionRepository, type IntakeD1 } from '../../../src/lib/submissions/index.ts';
import { SqliteD1 } from '../../hosted-smoke/intake/doubles.ts';
import { validateAgainst } from './fixtures.ts';
export { SqliteD1 };

export const CLIENT = id('client', 'client-a') as ClientId;
export const CASE_A = id('case', 'case-a') as CaseId;
export const CASE_B = id('case', 'case-b') as CaseId;
export const NOW = '2026-10-25T06:00:00.000Z';
const deny = (code: string) => Object.assign(new Error(code), { code, retryable: false });
const fault = (code: string) => Object.assign(new Error(code), { code, retryable: true });

export function person(subject: string, kind: 'staff' | 'client' = 'staff'): Principal { return { issuer: 'https://issuer.test', subject, kind }; }
export interface WhoOptions { kind?: 'verified' | 'anonymous'; clientId?: ClientId; subject?: string; principalKind?: 'staff' | 'client'; revoked?: boolean; session?: string }
export function who(o: WhoOptions = {}): Identity {
  const base = { clientId: o.clientId ?? CLIENT, checkRevocation: async () => { if (o.revoked) throw deny('invalid-session'); }, authorize: async () => { throw deny('forbidden'); } };
  return o.kind === 'anonymous'
    ? { ...base, kind: 'anonymous', principal: null, sessionId: null }
    : { ...base, kind: 'verified', principal: person(o.subject ?? 'operator-1', o.principalKind ?? 'staff'), sessionId: id('session', o.session ?? 'sess-operator-0001') as SessionId };
}

export interface OperateCall { principal: Principal; sessionId: SessionId; clientId: ClientId; caseId: CaseId }
/** The separate operate capability: allows exactly the listed cases for the trusted client. */
export function operateAuthority(cases: readonly CaseId[], calls: OperateCall[] = []) {
  return async (a: OperateCall) => {
    calls.push(a);
    if (a.clientId !== CLIENT || !cases.includes(a.caseId)) throw deny('forbidden');
  };
}

export class AuditRecorder {
  events: AuditEvent[] = [];
  failNext = false; failAlways = false;
  async append(e: AuditEvent) {
    if (this.failAlways || this.failNext) { this.failNext = false; throw fault('audit-unavailable'); }
    const prior = this.events.find((x) => x.eventId === e.eventId);
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(e)) throw deny('audit-conflict'); return { eventId: e.eventId }; }
    this.events.push(structuredClone(e));
    return { eventId: e.eventId };
  }
}

export interface StagedFiles { manifestSha256: string; files: ReadonlyMap<string, Uint8Array> }
/**
 * The stager double: the real validator over a case folder of exactly the finalized submitted files, memory for the
 * private candidate. `outcomeOverride` models a stager that misreports; `folder` is what the validator sees.
 */
export class ValidatingStager {
  calls: { operationId: string; caseId: string; files: ReadonlyMap<string, Uint8Array> }[] = [];
  readonly store = new Map<string, StagedFiles>();
  folder: ReadonlyMap<string, Uint8Array> = new Map();
  outcomeOverride: ((o: unknown) => unknown) | null = null;
  fail = false;
  async stage(a: { clientId: ClientId; caseId: CaseId; operationId: string; files: ReadonlyMap<string, Uint8Array>; identity: { resultsVersion: string; manifestSha256: string } }): Promise<unknown> {
    this.calls.push({ operationId: a.operationId, caseId: a.caseId, files: a.files });
    if (this.fail) throw fault('storage-unavailable');
    const v = await validateAgainst(a.files, this.folder);
    let out: unknown;
    if (!v.ok) out = { kind: 'refused', reason: 'rejected', detail: v.codes };
    else {
      const prior = this.store.get(v.value.resultsVersion);
      if (prior && prior.manifestSha256 !== v.value.manifestSha256) out = { kind: 'refused', reason: 'integrity', detail: ['a stored version with another manifest'] };
      else { this.store.set(v.value.resultsVersion, { manifestSha256: v.value.manifestSha256, files: new Map(a.files) }); out = { kind: 'staged', repeated: !!prior, ...v.value }; }
    }
    return this.outcomeOverride ? this.outcomeOverride(out) : out;
  }
}

/** The stored-package reader double the correction path reads the base candidate's exact bytes through. */
export class StoredPackages {
  private readonly stager: ValidatingStager;
  constructor(stager: ValidatingStager) { this.stager = stager; }
  tamper: ((files: Map<string, Uint8Array>) => void) | null = null;
  async files(a: { clientId: ClientId; caseId: CaseId; resultsVersion: string }): Promise<ReadonlyMap<string, Uint8Array> | null> {
    const s = this.stager.store.get(a.resultsVersion);
    if (!s) return null;
    const copy = new Map([...s.files].map(([p, b]) => [p, new Uint8Array(b)] as const));
    this.tamper?.(copy);
    return copy;
  }
}

export interface SubmittedFile { path: string; bytes: Uint8Array }
/** Drives the REAL intake repository (declare, stored, reserve, commit) so a manifest is a real finalized one. */
export async function finalizeSubmission(db: SqliteD1, o: { caseId?: CaseId; operationId: string; file: SubmittedFile; finalize?: boolean }) {
  const { shaOf } = await import('./fixtures.ts');
  const repo = d1SubmissionRepository(db as unknown as IntakeD1), caseId = o.caseId ?? CASE_A;
  const scope = { clientId: CLIENT, caseId };
  const at = '2026-10-25T05:00:00.000Z';
  const filename = o.file.path.split('/').pop()!;
  await repo.declare({ ...scope, operationId: o.operationId, assetId: `sub-${o.operationId}`, path: o.file.path, filename, mediaType: 'application/pdf', size: o.file.bytes.byteLength, sha256: shaOf(o.file.bytes), principal: { issuer: 'https://issuer.test', subject: 'client-user' }, at });
  await repo.markStored({ ...scope, operationId: o.operationId, at });
  if (o.finalize === false) return repo.reserveRevision({ ...scope, operationId: o.operationId, at });
  return repo.commitRevision({ ...scope, operationId: o.operationId, at });
}

/** A request body that records whether anything pulled from it, for the "authority before any body byte" rule. */
export function trackedBody(bytes: Uint8Array, chunk = 64) {
  const state = { pulled: 0 };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.byteLength) { c.close(); return; }
      const next = Math.min(bytes.byteLength, at + chunk);
      state.pulled += next - at;
      c.enqueue(bytes.slice(at, next));
      at = next;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}
