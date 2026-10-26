// Native /2 is an archive codec, not a database dump or an authority/import mechanism.
import type { CaseId, CaseRevision, ClientId, Publication, ResultsVersion, VersionInfo } from '../../server/runtime/contracts.ts';
import type { CloudD1, D1Value } from '../../storage/cloud/bindings.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../case-package/strict-json.ts';
import { canonicalText } from '../../case-package/canonical.ts';
import { safePath } from '../../submissions/path.ts';
import { authorizeAndAudit, recheck, recordAfter, recordFailure, requireCaseId, requireObjects } from './authority.ts';
import { canonicalJson, encode, fail, ID, objectKeys, SHA, sha256Hex } from './bytes.ts';
import { parseManifest, exportScopes, type VerifyRequest, type Verified } from './verify.ts';
import { requireVisible } from './visibility.ts';
import type { BlobRef, CaseAuditPort, ExportManifest, ExportResult, Limits, ReadBoundary, RecoveryDeps, VersionVisibilityPort } from './types.ts';
import type { AuditReadGate } from '../../audit/index.ts';

export const NATIVE_EXPORT_FORMAT = 'clearcase.recovery-export/2' as const;
export const NATIVE_EVIDENCE_FORMAT = 'clearcase.native-evidence/2' as const;
/** `case-audit/1`: the case's session-redacted audit history and native lineage, under the live case-audit entitlement.
 * `none`: no audit row and no native lineage, whose provenance is audit; a case that has lineage is unavailable to it. */
export type AuditScope = 'case-audit/1' | 'none';
export interface NativeEvidenceLimits { maxLineageRows: number; maxLineageBytes: number }
export interface NativeArchiveLimits extends Limits, NativeEvidenceLimits { maxManifestBytes: number }
/** Supplied by trusted composition; exact live version entitlement, not a case-level preview waiver. */
export interface NativeRecoveryPolicy extends NativeEvidenceLimits {
  /** Omit to retain publication-only policy. Historical/private versions still HOLD unless trusted composition
   * supplies an exact, live operator-entitlement policy; supplying only a case-level read grant is not sufficient. */
  visibility?: VersionVisibilityPort;
  /** Required by every /2 storage controller, even for audit-free archives. Exact live request principal/session/case. */
  audit?: Pick<AuditReadGate, 'caseAudit'>;
}
type Cell = string | number | null;
export type EvidenceRow = Record<string, Cell>;
export interface NativeEvidence {
  format: typeof NATIVE_EVIDENCE_FORMAT; audit: AuditScope;
  tables: Record<string, EvidenceRow[]>;
  rows: number; bytes: number; sha256: string;
}
export interface D1Observation { kind: 'primary-d1-batch'; startedAt: string; completedAt: string }
export interface ImmutableReference extends BlobRef {
  /** `pending-original`: the verified bytes of a `stored` upload that never finalized; never a case original. */
  kind: 'original' | 'pending-original' | 'package' | 'preview'; resultsVersion: string | null; assetId: string | null; path: string | null;
  objectKey: string; objectVersion: string; etag: string;
}
export interface NativeExportManifest extends Omit<ExportManifest, 'format' | 'source'> {
  format: typeof NATIVE_EXPORT_FORMAT;
  source: {
    d1: D1Observation;
    userWork: { revision: CaseRevision; observedAt: string };
    r2: { startedAt: string; completedAt: string; atomicWithD1: false };
    publication: Publication; activeVersion: ResultsVersion | null;
  };
  evidence: NativeEvidence;
  references: ImmutableReference[];
}
export interface NativeExportResult extends Omit<ExportResult, 'manifest'> { manifest: NativeExportManifest }
export interface EvidenceCapture { evidence: NativeEvidence; observation: D1Observation }
export interface NativeEvidencePort {
  readonly limits: Readonly<NativeArchiveLimits>;
  readonly visibility: VersionVisibilityPort;
  /** Null disables /2 storage controllers; it never selects audit-free authority. */
  readonly audit: CaseAuditPort | null;
  capture(a: { audit: AuditScope }): Promise<EvidenceCapture>;
  read(ref: Omit<ImmutableReference, 'blob' | 'objectVersion' | 'etag'>): Promise<{ bytes: Uint8Array; objectVersion: string; etag: string }>;
  userWorkRevision(boundary?: ReadBoundary): Promise<CaseRevision>;
}

// SQL identifiers and scopes are fixed source code. No received SQL, table name or predicate is executable.
// s=string, n=nonnegative safe integer, ?=nullable. Exact columns are checked again by the codec.
const SCHEMAS = {
  rs_case: 'case_id:s case_label:s?',
  rs_results_version: 'version_id:s case_id:s state:s manifest_sha256:s input_revision_id:s case_label:s? created:s verdict:s validator_version:s diagnostics_sha256:s warning_fingerprints:s expected_documents:n expected_assets:n expected_seeds:n expected_files:n read_model_sha256:s overview:s stored_at:s? import_seq:n',
  rs_package_file: 'version_id:s path:s sha256:s size:n object_key:s',
  rs_preview: 'version_id:s asset_id:s sha256:s size:n media_type:s filename:s object_key:s',
  rs_publication: 'case_id:s state:s version_id:s previous_version_id:s?',
  rs_version_withdrawal: 'version_id:s case_id:s withdrawn_at:s',
  rs_case_original: 'case_id:s asset_id:s sha256:s filename:s media_type:s finalized_at:s',
  rs_original: 'sha256:s size:n object_key:s',
  rs_original_upload: 'case_id:s operation_id:s asset_id:s sha256:s size:n filename:s media_type:s state:s put_attempts:n declared_at:s stored_at:s?',
  submissions_upload: 'client_id:s case_id:s operation_id:s asset_id:s path:s filename:s media_type:s size:n sha256:s state:s principal_issuer:s principal_subject:s declared_at:s stored_at:s?',
  submissions_revision: 'client_id:s case_id:s revision_id:s sequence:n operation_id:s file_count:n finalized_at:s',
  submissions_file: 'client_id:s case_id:s revision_id:s path:s path_key:s filename:s media_type:s size:n sha256:s asset_id:s',
  native_import_attempt: 'client_id:s case_id:s operation_id:s kind:s operator_issuer:s operator_subject:s request_sha256:s submission_revision_id:s base_candidate_id:s? declared_at:s',
  native_candidate: 'client_id:s case_id:s candidate_id:s results_version:s manifest_sha256:s input_revision_id:s origin:s parent_candidate_id:s? operation_id:s created_at:s',
  native_import_link: 'client_id:s case_id:s link_id:s candidate_id:s submission_revision_id:s submission_manifest_sha256:s results_version:s manifest_sha256:s input_revision_id:s coverage_json:s operator_issuer:s operator_subject:s linked_at:s link_sha256:s',
  native_candidate_supersession: 'client_id:s case_id:s old_candidate_id:s new_candidate_id:s reason:s operator_issuer:s operator_subject:s at:s',
  native_correction_change: 'client_id:s case_id:s candidate_id:s path:s before_sha256:s? before_size:n? after_sha256:s after_size:n',
  // JSON audit bodies are replaced at the source by a session-free archival projection. The stored body and its digest
  // (which covers the session) are read only to verify that body at capture, and are never archived.
  native_candidate_audit_intent: 'client_id:s case_id:s candidate_id:s event_id:s archival_event:s',
  native_candidate_audit_settlement: 'client_id:s case_id:s candidate_id:s event_id:s',
  native_audit_events: 'seq:n event_id:s client_id:s envelope:n class:s action:s object_kind:s object_id:s case_id:s version:s? outcome:s actor_kind:s at:s archival_event:s',
} as const;
type Table = keyof typeof SCHEMAS;
const TABLES = Object.keys(SCHEMAS) as Table[];
const SOURCE_AUDIT: Partial<Record<Table, { body: string; digest: string }>> = {
  native_candidate_audit_intent: { body: 'event_json', digest: 'event_sha256' }, native_audit_events: { body: 'canonical', digest: 'sha256' },
};
const AUDIT_TABLES: readonly Table[] = ['native_candidate_audit_intent', 'native_candidate_audit_settlement', 'native_audit_events'];
const LINEAGE_TABLES: readonly Table[] = [...AUDIT_TABLES, 'native_import_attempt', 'native_candidate', 'native_import_link', 'native_candidate_supersession', 'native_correction_change'];
const RV = /^sha256:[0-9a-f]{64}$/;
const fields = (t: Table) => SCHEMAS[t].split(' ').map((x) => x.split(':') as [string, string]);
function bad(): never { throw fail('manifest-invalid'); }
function missing(): never { throw fail('export-incomplete'); }
function unavailable(): never { throw fail('recovery-unavailable', true); }
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function exact(x: unknown, keys: string[]): asserts x is Record<string, unknown> {
  if (!obj(x) || Object.keys(x).sort().join() !== keys.slice().sort().join()) bad();
}
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const iso = (x: unknown) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && !Number.isNaN(Date.parse(x));
const json = (s: string): unknown => { try { return parseStrictJson(s); } catch { return bad(); } };
function jsonBytes(bytes: Uint8Array): unknown { try { return json(decodeUtf8Strict(bytes)); } catch { return bad(); } }
const hash = (v: unknown) => sha256Hex(encode(canonicalJson(v)));
const eq = (a: unknown, b: unknown) => { if (canonicalJson(a) !== canonicalJson(b)) bad(); };
function unique(rows: EvidenceRow[], keys: string[]) {
  const seen = new Set<string>();
  for (const r of rows) { const k = canonicalJson(keys.map((c) => r[c])); if (seen.has(k)) bad(); seen.add(k); }
}
export function nativeLimits(value: NativeArchiveLimits): Readonly<NativeArchiveLimits> {
  exact(value, ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxManifestBytes', 'maxLineageRows', 'maxLineageBytes']);
  if (!Object.values(value).every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) || value.maxFileBytes > value.maxTotalBytes) unavailable();
  return Object.freeze({ ...value });
}
function scope(t: Table, clientId: ClientId, caseId: CaseId, audit: AuditScope): { sql: string; values: D1Value[] } {
  if (audit === 'none' && AUDIT_TABLES.includes(t)) return { sql: '0', values: [] };
  if (t === 'rs_original') return { sql: 'sha256 IN (SELECT sha256 FROM rs_case_original WHERE case_id = ?)', values: [caseId] };
  if (t === 'rs_package_file' || t === 'rs_preview') return { sql: 'version_id IN (SELECT version_id FROM rs_results_version WHERE case_id = ?)', values: [caseId] };
  if (SCHEMAS[t].includes('client_id:')) return { sql: 'client_id = ? AND case_id = ?', values: [clientId, caseId] };
  return { sql: 'case_id = ?', values: [caseId] };
}

/** Projects the actual stored audit body. This NEVER produces an Identity, Principal, session or replayable event. */
async function archiveAudit(raw: string, digest: string, intent: boolean, clientId: ClientId, caseId: CaseId): Promise<string> {
  if (!SHA.test(digest) || await sha256Hex(encode(raw)) !== digest) bad();
  const parsed = json(raw);
  if (canonicalJson(parsed) !== raw) bad();
  let event = parsed;
  if (!intent) { exact(parsed, ['envelope', 'event']); if (parsed.envelope !== 1) bad(); event = parsed.event; }
  exact(event, ['eventId', 'actor', 'action', 'object', 'version', 'outcome', 'at']);
  exact(event.object, ['kind', 'id', 'caseId']);
  if (event.object.caseId !== caseId || !text(event.eventId) || !text(event.action) || !text(event.object.id) || !text(event.object.kind) || !iso(event.at) || !['succeeded', 'denied', 'failed', 'refused'].includes(String(event.outcome))) bad();
  const actor = event.actor; if (!obj(actor)) bad();
  let archivalActor: Record<string, unknown>;
  if (actor.kind === 'verified') {
    exact(actor, ['kind', 'principal', 'sessionId']); if (!text(actor.sessionId)) bad();
    exact(actor.principal, ['issuer', 'subject', 'kind']);
    if (!text(actor.principal.issuer) || !text(actor.principal.subject) || !['client', 'staff'].includes(String(actor.principal.kind))) bad();
    archivalActor = { kind: 'historical', issuer: actor.principal.issuer, subject: actor.principal.subject, principalKind: actor.principal.kind };
  } else if (actor.kind === 'anonymous') {
    exact(actor, ['kind', 'principal', 'sessionId']); if (actor.principal !== null || actor.sessionId !== null || intent) bad();
    archivalActor = { kind: 'historical-anonymous' };
  } else {
    exact(actor, ['kind', 'component', 'operator']); if (actor.kind !== 'system' || actor.component !== 'provisioning' || !text(actor.operator) || intent) bad();
    archivalActor = { kind: 'historical-system', component: 'provisioning', operator: actor.operator };
  }
  // As the audit reader shows it: never a session id or a digest of one. `redacted` names what the stored event held beyond this.
  return canonicalJson({ eventId: event.eventId, action: event.action, object: event.object, version: event.version, outcome: event.outcome, at: event.at, actor: archivalActor, clientId, redacted: actor.kind === 'verified' ? ['actor.sessionId'] : [] });
}
function validateArchiveEvent(raw: Cell, clientId: ClientId, caseId: CaseId): Record<string, unknown> {
  if (typeof raw !== 'string') return bad();
  const e = json(raw);
  exact(e, ['eventId', 'action', 'object', 'version', 'outcome', 'at', 'actor', 'clientId', 'redacted']);
  if (!obj(e.actor)) bad();
  eq(e.redacted, e.actor.kind === 'historical' ? ['actor.sessionId'] : []);
  if (e.actor.kind === 'historical') {
    exact(e.actor, ['kind', 'issuer', 'subject', 'principalKind']);
    if (!['staff', 'client'].includes(String(e.actor.principalKind)) || !text(e.actor.issuer) || !text(e.actor.subject)) bad();
  } else if (e.actor.kind === 'historical-anonymous') exact(e.actor, ['kind']);
  else {
    exact(e.actor, ['kind', 'component', 'operator']);
    if (e.actor.kind !== 'historical-system' || e.actor.component !== 'provisioning' || !text(e.actor.operator)) bad();
  }
  exact(e.object, ['kind', 'id', 'caseId']);
  if (e.clientId !== clientId || e.object.caseId !== caseId || !text(e.eventId) || !text(e.action) || !text(e.object.kind) || !text(e.object.id) || !iso(e.at) || !['succeeded', 'denied', 'failed', 'refused'].includes(String(e.outcome)) || (e.version !== null && !text(e.version))) bad();
  if (canonicalJson(e) !== raw) bad();
  return e;
}

/** One primary batch, not alternating observations. Aggregates bound raw row bytes before any payload is used.
 * Oversized text columns are not transferred; every response, including the aggregates, must be complete and successful.
 */
export function primaryEvidenceReader(a: { openPrimary(): CloudD1; clientId: ClientId; caseId: CaseId; limits: NativeArchiveLimits; now(): Date; check(audit: AuditScope): Promise<void> }): (audit: AuditScope) => Promise<EvidenceCapture> {
  const limits = nativeLimits(a.limits);
  return async (audit) => {
    if (audit !== 'case-audit/1' && audit !== 'none') unavailable();
    await a.check(audit); // authorize the selected history BEFORE opening/preparing the protected primary batch
    let db: CloudD1;
    try { db = a.openPrimary(); } catch { return unavailable(); }
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') unavailable();
    // first-primary constrains the FIRST operation only: no gate/catalogue IO may consume it before this batch.
    const startedAt = a.now().toISOString();
    const queries = TABLES.flatMap((t) => {
      const source = SOURCE_AUDIT[t];
      const f = [...fields(t).map(([k]) => k).filter((k) => k !== 'archival_event'), ...(source ? [source.body, source.digest] : [])];
      const s = scope(t, a.clientId, a.caseId, audit);
      const rowJson = `json_object(${f.map((k) => `'${k}', ${k}`).join(', ')})`;
      const columns = f.join(', ');
      // Batch cannot branch in JS. Guard each payload SELECT in SQL, so an oversized table transfers no bodies.
      // The fixed table count also bounds transient transport; the aggregates below enforce the global policy.
      const bounded = `(SELECT coalesce(sum(length(CAST(${rowJson} AS BLOB))), 0) FROM ${t} WHERE ${s.sql}) <= ?
        AND (SELECT count(*) FROM ${t} WHERE ${s.sql}) <= ?`;
      return [
        db.prepare(`SELECT count(*) AS rows, coalesce(sum(length(CAST(${rowJson} AS BLOB))), 0) AS bytes FROM ${t} WHERE ${s.sql}`).bind(...s.values),
        db.prepare(`SELECT ${columns} FROM ${t} WHERE (${s.sql}) AND ${bounded} ORDER BY ${f[0]}, ${f[1] ?? f[0]} LIMIT ?`)
          .bind(...s.values, ...s.values, limits.maxLineageBytes, ...s.values, limits.maxLineageRows, limits.maxLineageRows + 1),
      ];
    });
    let results: unknown[];
    try { results = await db.batch(queries); } catch { return unavailable(); }
    const completedAt = a.now().toISOString();
    if (!Array.isArray(results) || results.length !== TABLES.length * 2) unavailable();
    const rowsOf = (i: number): EvidenceRow[] => {
      const r = results[i];
      if (!obj(r) || r.success !== true || !Array.isArray(r.results)) return unavailable();
      return r.results as EvidenceRow[];
    };
    let rawRows = 0, rawBytes = 0;
    for (let i = 0; i < TABLES.length; i++) {
      const count = rowsOf(i * 2);
      if (count.length !== 1 || !Number.isSafeInteger(count[0]!.rows) || !Number.isSafeInteger(count[0]!.bytes) || Number(count[0]!.rows) < 0 || Number(count[0]!.bytes) < 0) unavailable();
      rawRows += Number(count[0]!.rows); rawBytes += Number(count[0]!.bytes);
      if (rawRows > a.limits.maxLineageRows || rawBytes > a.limits.maxLineageBytes) throw fail('export-too-large');
      if (rowsOf(i * 2 + 1).length !== count[0]!.rows) unavailable();
    }
    const tables: NativeEvidence['tables'] = {};
    for (let i = 0; i < TABLES.length; i++) {
      const t = TABLES[i]!;
      const out: EvidenceRow[] = [];
      for (const input of rowsOf(i * 2 + 1)) {
        const r = { ...input };
        const source = SOURCE_AUDIT[t];
        if (source) {
          if (typeof r[source.body] !== 'string' || typeof r[source.digest] !== 'string') bad();
          r.archival_event = await archiveAudit(r[source.body] as string, r[source.digest] as string, t !== 'native_audit_events', a.clientId, a.caseId);
          delete r[source.body]; delete r[source.digest];
        }
        out.push(r);
      }
      // Canonical row ordering is independent of driver row order or text collation.
      tables[t] = out.sort((x, y) => { const a = canonicalJson(x), b = canonicalJson(y); return a < b ? -1 : a > b ? 1 : 0; });
    }
    const evidence: NativeEvidence = { format: NATIVE_EVIDENCE_FORMAT, audit, tables, rows: rawRows, bytes: encode(canonicalJson(tables)).length, sha256: await hash(tables) };
    await validateEvidence(evidence, a.clientId, a.caseId, a.limits);
    await a.check(audit);
    return { evidence, observation: { kind: 'primary-d1-batch', startedAt, completedAt } };
  };
}

/** All linkage checks use only this captured, whitelisted row set, never current pointers or alternate SQL reads. */
export async function validateEvidence(e: NativeEvidence, clientId: ClientId, caseId: CaseId, limits: NativeArchiveLimits): Promise<void> {
  exact(e, ['format', 'audit', 'tables', 'rows', 'bytes', 'sha256']); exact(e.tables, TABLES);
  if (e.format !== NATIVE_EVIDENCE_FORMAT || !SHA.test(e.sha256) || (e.audit !== 'case-audit/1' && e.audit !== 'none')) bad();
  let count = 0;
  for (const t of TABLES) {
    const rows = e.tables[t]; if (!Array.isArray(rows)) bad(); count += rows.length;
    for (const r of rows) {
      exact(r, fields(t).map(([k]) => k));
      for (const [k, type] of fields(t)) {
        const v = r[k];
        if (v === null && type.endsWith('?')) continue;
        if (type.startsWith('n') ? !Number.isSafeInteger(v) || Number(v) < 0 : typeof v !== 'string') bad();
        if (k === 'client_id' && v !== clientId || k === 'case_id' && v !== caseId) throw fail('foreign-input');
        if (k.endsWith('sha256') && (typeof v !== 'string' || !(['diagnostics_sha256', 'read_model_sha256'].includes(k) ? /^sha256:[0-9a-f]{64}$/.test(v) : SHA.test(v)))) bad();
      }
    }
  }
  const size = encode(canonicalJson(e.tables)).length;
  if (count > limits.maxLineageRows || size > limits.maxLineageBytes) throw fail('export-too-large');
  if (e.rows !== count || e.bytes !== size || e.sha256 !== await hash(e.tables)) bad();
  const T = (t: Table) => e.tables[t]!;
  const one = (t: Table, key: string, value: Cell): EvidenceRow => {
    const hits = T(t).filter((r) => r[key] === value); if (hits.length !== 1) return missing(); return hits[0]!;
  };
  if (T('rs_case').length !== 1) missing();
  // Lineage provenance is audit: without the case-audit scope it is never archived, and never silently dropped.
  if (e.audit === 'none' && LINEAGE_TABLES.some((t) => T(t).length > 0)) unavailable();
  const keys: Partial<Record<Table, string[]>> = {
    rs_case: ['case_id'], rs_results_version: ['version_id'], rs_package_file: ['version_id', 'path'], rs_preview: ['version_id', 'asset_id'], rs_original: ['sha256'], rs_case_original: ['asset_id'], rs_original_upload: ['operation_id'],
    rs_publication: ['case_id'], rs_version_withdrawal: ['version_id'], submissions_upload: ['operation_id'], submissions_revision: ['revision_id'], submissions_file: ['revision_id', 'path_key'], native_import_attempt: ['operation_id'], native_candidate: ['candidate_id'],
    native_import_link: ['link_id'], native_candidate_supersession: ['old_candidate_id'], native_correction_change: ['candidate_id', 'path'], native_candidate_audit_intent: ['candidate_id'], native_candidate_audit_settlement: ['candidate_id'], native_audit_events: ['event_id'],
  };
  for (const t of TABLES) unique(T(t), keys[t]!);
  unique(T('native_candidate'), ['results_version']); unique(T('native_candidate'), ['operation_id']); unique(T('native_import_link'), ['candidate_id']); unique(T('native_candidate_supersession'), ['new_candidate_id']);
  unique(T('native_candidate_audit_intent'), ['event_id']); unique(T('submissions_revision'), ['operation_id']); unique(T('submissions_revision'), ['sequence']); unique(T('submissions_upload'), ['asset_id']);
  for (const o of T('rs_case_original')) one('rs_original', 'sha256', o.sha256);
  for (const r of T('rs_original')) if (!T('rs_case_original').some((o) => o.sha256 === r.sha256)) bad();
  // An unfinished upload is archived as its persisted state. It claims a revision only once the schema recorded one, and a
  // case original only once one is bound; a finalized one, and anything lineage references, needs all of it.
  for (const u of T('submissions_upload')) {
    if (!['received', 'stored', 'reserved', 'finalized'].includes(String(u.state))) bad();
    const revs = T('submissions_revision').filter((r) => r.operation_id === u.operation_id);
    if (!revs.length) { if (u.state === 'reserved' || u.state === 'finalized') missing(); continue; }
    if (u.state === 'received') bad();
    const rev = revs[0]!;
    if (rev.revision_id !== `subrev-${u.operation_id}` || rev.file_count !== 1 || Number(rev.sequence) < 1) bad();
    const f = one('submissions_file', 'revision_id', rev.revision_id);
    for (const k of ['path', 'filename', 'media_type', 'size', 'sha256', 'asset_id']) eq(f[k], u[k]);
    const path = safePath(f.path);
    if (!path || path.path !== f.path || path.key !== f.path_key || path.filename !== f.filename || f.media_type !== 'application/pdf' || Number(f.size) <= 0) bad();
    const bound = T('rs_case_original').filter((o) => o.asset_id === f.asset_id);
    if (u.state === 'finalized' && bound.length !== 1) missing();
    for (const o of bound) { for (const k of ['sha256', 'filename', 'media_type']) eq(o[k], f[k]); eq(one('rs_original', 'sha256', f.sha256).size, f.size); }
  }
  for (const rev of T('submissions_revision')) one('submissions_upload', 'operation_id', rev.operation_id);
  for (const f of T('submissions_file')) one('submissions_revision', 'revision_id', f.revision_id);
  const finalSubmission = (revisionId: Cell) => {
    const rev = one('submissions_revision', 'revision_id', revisionId);
    if (one('submissions_upload', 'operation_id', rev.operation_id).state !== 'finalized') missing();
    return rev;
  };
  for (const r of T('rs_original_upload')) {
    if (!['declared', 'stored', 'finalized'].includes(String(r.state))) bad();
    if (r.state !== 'finalized') continue; // a `stored` one's verified bytes are a pending-original reference
    const o = one('rs_case_original', 'asset_id', r.asset_id), b = one('rs_original', 'sha256', r.sha256);
    for (const k of ['sha256', 'filename', 'media_type']) eq(o[k], r[k]); eq(b.size, r.size);
  }
  const storedVersion = (id: Cell) => { const v = one('rs_results_version', 'version_id', id); if (v.state !== 'stored') missing(); return v; };
  for (const v of T('rs_results_version')) {
    if (!['stored', 'staging'].includes(String(v.state)) || !RV.test(String(v.version_id))) missing();
    // An unfinished import is archived as staging metadata: no candidate, package bytes, previews or publication claimed.
    if (v.state === 'staging') continue;
    one('native_candidate', 'results_version', v.version_id);
    const files = T('rs_package_file').filter((r) => r.version_id === v.version_id);
    if (files.length !== v.expected_files || files.find((r) => r.path === 'manifest.json')?.sha256 !== v.manifest_sha256) missing();
  }
  for (const r of [...T('rs_package_file'), ...T('rs_preview'), ...T('rs_version_withdrawal')]) one('rs_results_version', 'version_id', r.version_id);
  for (const w of T('rs_version_withdrawal')) storedVersion(w.version_id);
  for (const p of T('rs_publication')) { storedVersion(p.version_id); if (p.previous_version_id !== null) storedVersion(p.previous_version_id); if (!['published', 'withdrawn'].includes(String(p.state))) bad(); }
  for (const c of T('native_candidate')) {
    const v = storedVersion(c.results_version), l = one('native_import_link', 'candidate_id', c.candidate_id), at = one('native_import_attempt', 'operation_id', c.operation_id);
    for (const k of ['manifest_sha256', 'input_revision_id']) { eq(c[k], v[k]); eq(l[k], c[k]); }
    eq(l.results_version, c.results_version); eq(at.submission_revision_id, l.submission_revision_id); eq(at.kind, c.origin); eq(at.base_candidate_id, c.parent_candidate_id);
    eq(l.operator_issuer, at.operator_issuer); eq(l.operator_subject, at.operator_subject); eq(l.linked_at, c.created_at);
    const rev = finalSubmission(l.submission_revision_id);
    const files = T('submissions_file').filter((f) => f.revision_id === rev.revision_id).sort((x, y) => String(x.path_key).localeCompare(String(y.path_key)));
    const manifest = { format: 'clearcase.submission-manifest/1', clientId, caseId, revisionId: rev.revision_id, sequence: rev.sequence, operationId: rev.operation_id, finalizedAt: rev.finalized_at,
      files: files.map((f) => ({ path: f.path, filename: f.filename, mediaType: f.media_type, size: f.size, sha256: f.sha256, assetId: f.asset_id })) };
    if (await sha256Hex(encode(canonicalText(manifest))) !== l.submission_manifest_sha256) bad();
    const coverage = json(String(l.coverage_json)); validateCoverage(coverage, files);
    const link = { format: 'clearcase.candidate-import-link/1', linkId: l.link_id, clientId, caseId, submissionRevisionId: l.submission_revision_id, submissionManifestSha256: l.submission_manifest_sha256,
      candidate: { clientId, caseId, candidateId: c.candidate_id, resultsVersion: c.results_version, manifestSha256: c.manifest_sha256, packageInputRevisionId: c.input_revision_id },
      coverage, operator: { issuer: l.operator_issuer, subject: l.operator_subject, kind: 'staff' }, linkedAt: l.linked_at, attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked' };
    if (await hash(link) !== l.link_sha256) bad();
    const intent = one('native_candidate_audit_intent', 'candidate_id', c.candidate_id), event = validateArchiveEvent(intent.archival_event, clientId, caseId);
    exact(event.actor, ['kind', 'issuer', 'subject', 'principalKind']);
    const actor = event.actor;
    if (event.eventId !== intent.event_id || event.action !== (c.origin === 'import' ? 'results.import-candidate' : 'results.correct-candidate') || event.version !== c.results_version || event.outcome !== 'succeeded' || event.at !== l.linked_at || actor.issuer !== l.operator_issuer || actor.subject !== l.operator_subject || actor.principalKind !== 'staff') bad();
    eq(event.object, { kind: 'candidate', id: c.candidate_id, caseId });
    // The persisted id embeds a 12-hex session discriminator; it is kept as the original identifier, as the audit reader shows it.
    const prefix = `native-${c.origin}-${l.link_id}-`, eventId = String(intent.event_id);
    if (!eventId.startsWith(prefix) || !/^[0-9a-f]{12}$/.test(eventId.slice(prefix.length))) bad();
    const settled = T('native_candidate_audit_settlement').filter((s) => s.candidate_id === c.candidate_id);
    if (settled.length) {
      eq(settled[0]!.event_id, intent.event_id);
      const logged = one('native_audit_events', 'event_id', intent.event_id); eq(logged.archival_event, intent.archival_event);
    }
    if (c.origin === 'correction') {
      const parent = one('native_candidate', 'candidate_id', c.parent_candidate_id), sup = one('native_candidate_supersession', 'new_candidate_id', c.candidate_id);
      if (Number(one('rs_results_version', 'version_id', parent.results_version).import_seq) >= Number(v.import_seq)) bad();
      eq(sup.old_candidate_id, parent.candidate_id); eq(sup.operator_issuer, l.operator_issuer); eq(sup.operator_subject, l.operator_subject); eq(sup.at, c.created_at);
      if (!text(sup.reason) || sup.reason.length > 500) bad();
      const changes = T('native_correction_change').filter((r) => r.candidate_id === c.candidate_id);
      if (!changes.length) missing();
      const before = T('rs_package_file').filter((r) => r.version_id === parent.results_version), after = T('rs_package_file').filter((r) => r.version_id === c.results_version);
      // Native correction facts record replacement payloads, not the regenerated manifest identity.
      const changed = after.filter((r) => r.path !== 'manifest.json').filter((r) => { const b = before.find((x) => x.path === r.path); return !b || b.sha256 !== r.sha256 || b.size !== r.size; });
      if (changes.length !== changed.length || before.some((b) => !after.some((r) => r.path === b.path))) bad();
      for (const ch of changes) {
        const b = before.find((r) => r.path === ch.path), n = changed.find((r) => r.path === ch.path); if (!n) bad();
        eq(ch.before_sha256, b?.sha256 ?? null); eq(ch.before_size, b?.size ?? null); eq(ch.after_sha256, n.sha256); eq(ch.after_size, n.size);
      }
    } else if (c.origin !== 'import' || c.parent_candidate_id !== null || T('native_correction_change').some((r) => r.candidate_id === c.candidate_id)) bad();
  }
  for (const r of T('native_import_link')) one('native_candidate', 'candidate_id', r.candidate_id);
  for (const r of [...T('native_candidate_audit_intent'), ...T('native_candidate_audit_settlement'), ...T('native_correction_change')]) one('native_candidate', 'candidate_id', r.candidate_id);
  for (const s of T('native_candidate_supersession')) { const c = one('native_candidate', 'candidate_id', s.new_candidate_id); if (c.origin !== 'correction' || c.parent_candidate_id !== s.old_candidate_id) bad(); }
  for (const a of T('native_import_attempt')) {
    finalSubmission(a.submission_revision_id);
    if (a.kind === 'correction') one('native_candidate', 'candidate_id', a.base_candidate_id);
    else if (a.kind !== 'import' || a.base_candidate_id !== null) bad();
  }
  for (const r of T('native_audit_events')) {
    const ev = validateArchiveEvent(r.archival_event, clientId, caseId);
    eq(ev.eventId, r.event_id); eq(ev.action, r.action); eq(ev.version, r.version); eq(ev.outcome, r.outcome); eq(ev.at, r.at);
    eq(ev.object, { kind: r.object_kind, id: r.object_id, caseId });
    const actor = ev.actor as Record<string, unknown>;
    const recordedKind = actor.kind === 'historical' ? 'verified' : actor.kind === 'historical-system' ? 'system' : 'anonymous';
    if (r.envelope !== 1 || r.actor_kind !== recordedKind || !['protected', 'read', 'denial'].includes(String(r.class))) bad();
    if (typeof r.version === 'string' && r.version.startsWith('sha256:')) one('rs_results_version', 'version_id', r.version);
  }
}
function validateCoverage(c: unknown, files: EvidenceRow[]) {
  exact(c, ['policy', 'mappedOriginals', 'unavailableOriginals']);
  if (c.policy !== 'exact-required-file-set/1' || !Array.isArray(c.mappedOriginals) || !Array.isArray(c.unavailableOriginals)) bad();
  const refs = new Set<string>();
  for (const m of c.mappedOriginals) {
    if (!obj(m)) bad();
    exact(m, ['packageRefs', 'packagePath', 'storedPath', 'submissionAssetId', 'sha256', 'size', 'pathMatch', ...(m.pathMatch === 'case-nfc-unique' ? ['preservedWarning'] : [])]);
    if (!Array.isArray(m.packageRefs) || !m.packageRefs.length || !text(m.packagePath) || !text(m.storedPath)) bad();
    for (const ref of m.packageRefs) { if (!text(ref) || refs.has(ref)) bad(); refs.add(ref); }
    const f = files.find((f) => f.path === m.storedPath && f.asset_id === m.submissionAssetId && f.sha256 === m.sha256 && f.size === m.size); if (!f) missing();
    if (m.pathMatch === 'literal') { if (m.packagePath !== m.storedPath) bad(); }
    else if (m.pathMatch === 'case-nfc-unique') {
      if (m.packagePath === m.storedPath || m.packagePath.normalize('NFC').toLowerCase() !== m.storedPath.normalize('NFC').toLowerCase()) bad();
      exact(m.preservedWarning, ['code', 'fingerprints']); if (m.preservedWarning.code !== 'ORIG_CASE_MISMATCH' || !Array.isArray(m.preservedWarning.fingerprints) || !m.preservedWarning.fingerprints.length || !m.preservedWarning.fingerprints.every(text)) bad();
    } else bad();
  }
  for (const u of c.unavailableOriginals) {
    if (!obj(u)) bad(); exact(u, u.kind === 'missing' ? ['kind', 'ref', 'path'] : ['kind', 'ref', 'parentRef']);
    if (!['missing', 'embedded'].includes(String(u.kind)) || !text(u.ref) || refs.has(u.ref) || !text(u.kind === 'missing' ? u.path : u.parentRef)) bad(); refs.add(u.ref);
  }
}

export function expectedReferences(e: NativeEvidence): Omit<ImmutableReference, 'blob' | 'objectVersion' | 'etag'>[] {
  const t = e.tables, stored = new Set(t.rs_results_version!.filter((v) => v.state === 'stored').map((v) => v.version_id));
  for (const r of [...t.rs_package_file!, ...t.rs_preview!]) if (r.object_key !== `${'path' in r ? 'pkg' : 'preview'}/${String(r.version_id).slice(7)}/${r.sha256}`) bad();
  const bound = new Set(t.rs_original!.map((r) => r.sha256));
  const references = [
    ...t.rs_case_original!.map((o) => { const r = t.rs_original!.find((r) => r.sha256 === o.sha256)!; return { kind: 'original' as const, resultsVersion: null, assetId: String(o.asset_id), path: null, objectKey: String(r.object_key), sha256: String(r.sha256), size: Number(r.size) }; }),
    // The original store acknowledged these bytes; a declared one has none and is archived as metadata only.
    ...t.rs_original_upload!.filter((u) => u.state === 'stored' && !bound.has(u.sha256)).map((u) => ({ kind: 'pending-original' as const, resultsVersion: null, assetId: String(u.asset_id), path: null, objectKey: `orig/${u.sha256}`, sha256: String(u.sha256), size: Number(u.size) })),
    ...t.rs_package_file!.filter((r) => stored.has(r.version_id)).map((r) => ({ kind: 'package' as const, resultsVersion: String(r.version_id), assetId: null, path: String(r.path), objectKey: String(r.object_key), sha256: String(r.sha256), size: Number(r.size) })),
    ...t.rs_preview!.filter((r) => stored.has(r.version_id)).map((r) => ({ kind: 'preview' as const, resultsVersion: String(r.version_id), assetId: String(r.asset_id), path: null, objectKey: String(r.object_key), sha256: String(r.sha256), size: Number(r.size) })),
  ];
  for (const r of references) if (r.kind.endsWith('original') && r.objectKey !== `orig/${r.sha256}`) bad();
  return references;
}
/** Every version identity the archive carries, staging included: each is released only under live version visibility. */
export const evidenceVersionIds = (e: NativeEvidence) => e.tables.rs_results_version!.map((r) => r.version_id as ResultsVersion);
export function evidenceVersions(e: NativeEvidence): VersionInfo[] {
  return e.tables.rs_results_version!.filter((r) => r.state === 'stored').map((r) => ({ id: r.version_id, case_id: r.case_id, case_label: r.case_label, input_revision_id: r.input_revision_id, created: r.created,
    import_id: r.import_seq, verdict: r.verdict, stored_at: r.stored_at, manifest_sha256: r.manifest_sha256, diagnostics_sha256: r.diagnostics_sha256, validator_version: r.validator_version,
    warning_fingerprints: r.warning_fingerprints, read_model_sha256: r.read_model_sha256, overview: r.overview,
    expect: JSON.stringify({ documents: r.expected_documents, assets: r.expected_assets, seeds: r.expected_seeds, files: r.expected_files }) }) as VersionInfo);
}
/** Internal compatibility view for existing accounting/authority/restore logic only. /2 never serializes caseRevision. */
export function legacyView(m: NativeExportManifest): ExportManifest {
  const { evidence: _e, references: _r, ...base } = m;
  return { ...base, format: 'clearcase.recovery-export/1', source: { caseRevision: m.source.userWork.revision, publication: m.source.publication, activeVersion: m.source.activeVersion } };
}
export function nativePort(deps: RecoveryDeps): NativeEvidencePort {
  const p = deps.nativeEvidence;
  if (!p || typeof p.capture !== 'function' || typeof p.read !== 'function' || typeof p.userWorkRevision !== 'function' || !p.visibility || (deps.profile === 'production' && p.visibility.kind !== 'current-policy')) return unavailable();
  if (!p.audit || typeof p.audit.requireCaseAudit !== 'function' || (deps.profile === 'production' && p.audit.kind !== 'current-policy')) return unavailable();
  nativeLimits(p.limits); return p;
}
export function nativeAuthorityDeps(deps: RecoveryDeps): RecoveryDeps { return { ...deps, visibility: nativePort(deps).visibility }; }
/** Every /2 storage operation requires live case-audit authority, including before an unclassified manifest read.
 * Scope comes from the trusted request/composition, never from archived audit selection or identity claims. */
export async function requireAuditView(deps: RecoveryDeps, caseId: CaseId) {
  const port = nativePort(deps).audit;
  if (!port) unavailable();
  await port.requireCaseAudit({ identity: deps.identity, caseId });
}
/** Every native release/commit boundary: audit entitlement, live visibility of every carried version, then case authority. */
export async function recheckNative(deps: RecoveryDeps, m: NativeExportManifest, scopes: Parameters<typeof recheck>[1]) {
  const auth = nativeAuthorityDeps(deps);
  await requireAuditView(deps, m.caseId);
  for (const id of evidenceVersionIds(m.evidence)) await requireVisible(auth, m.caseId, id);
  // The validated evidence contains every identity (including publication/active/staging). Do not repeat policy IO
  // after the final case-authority observation, or alternate independently revocable gates indefinitely.
  await recheck(auth, scopes);
}

export async function parseNativeManifest(bytes: Uint8Array, limits: NativeArchiveLimits): Promise<NativeExportManifest> {
  nativeLimits(limits);
  if (bytes.length > limits.maxManifestBytes) throw fail('export-too-large');
  const raw = jsonBytes(bytes);
  exact(raw, ['format', 'exportId', 'clientId', 'caseId', 'createdAt', 'createdBy', 'source', 'selection', 'originals', 'embedded', 'previews', 'resultsVersions', 'userWork', 'accounting', 'evidence', 'references']);
  if (raw.format !== NATIVE_EXPORT_FORMAT) bad();
  const m = raw as unknown as NativeExportManifest;
  exact(m.source, ['d1', 'userWork', 'r2', 'publication', 'activeVersion']); exact(m.source.d1, ['kind', 'startedAt', 'completedAt']); exact(m.source.r2, ['startedAt', 'completedAt', 'atomicWithD1']);
  if (m.source.d1.kind !== 'primary-d1-batch' || m.source.r2.atomicWithD1 !== false || !iso(m.createdAt) || !iso(m.source.d1.startedAt) || !iso(m.source.d1.completedAt) || !iso(m.source.r2.startedAt) || !iso(m.source.r2.completedAt)) bad();
  exact(m.source.userWork, ['revision', 'observedAt']); if (!text(m.source.userWork.revision) || !iso(m.source.userWork.observedAt)) bad();
  if (m.userWork !== null) {
    exact(m.userWork, ['sha256', 'size', 'blob', 'exportedAt', 'tables', 'rows']);
    if (!iso(m.userWork.exportedAt) || !Number.isSafeInteger(m.userWork.tables) || m.userWork.tables < 0 || !Number.isSafeInteger(m.userWork.rows) || m.userWork.rows < 0) bad();
  }
  if (!obj(m.source.publication)) bad();
  exact(m.source.publication, m.source.publication.kind === 'published' ? ['kind', 'resultsVersion'] : ['kind']);
  if (Date.parse(m.source.d1.startedAt) > Date.parse(m.source.d1.completedAt) || Date.parse(m.source.r2.startedAt) > Date.parse(m.source.r2.completedAt)) bad();
  exact(m.createdBy, ['issuer', 'subject', 'kind']); if (!text(m.createdBy.issuer) || !text(m.createdBy.subject) || !['staff', 'client'].includes(m.createdBy.kind)) bad();
  exact(m.selection, ['originals', 'previews', 'resultsPackages', 'userWork']); if (m.selection.originals !== true || m.selection.previews !== true || m.selection.resultsPackages !== true) bad();
  const view = legacyView(m); parseManifest(encode(canonicalJson(view)));
  await validateEvidence(m.evidence, m.clientId, m.caseId, limits);
  if (!Array.isArray(m.references) || m.embedded.length) bad();
  const expected = expectedReferences(m.evidence);
  if (expected.length !== m.references.length) missing();
  for (let i = 0; i < expected.length; i++) {
    const r = m.references[i]!; exact(r, ['kind', 'resultsVersion', 'assetId', 'path', 'objectKey', 'sha256', 'size', 'blob', 'objectVersion', 'etag']);
    const { blob, objectVersion, etag, ...binding } = r;
    eq(binding, expected[i]); if (blob !== `blobs/${r.sha256}` || !text(objectVersion) || !text(etag)) bad();
  }
  const entries = [...m.references, ...(m.userWork ? [m.userWork] : [])];
  if (entries.length > limits.maxFiles || entries.some((r) => r.size > limits.maxFileBytes) || entries.reduce((n, r) => n + r.size, 0) > limits.maxTotalBytes) throw fail('export-too-large');
  eq(m.resultsVersions.map((v) => v.version), evidenceVersions(m.evidence));
  for (const v of m.resultsVersions) { exact(v, ['version', 'files']); eq(v.files, m.references.filter((r) => r.kind === 'package' && r.resultsVersion === v.version.id).map((r) => ({ path: r.path, sha256: r.sha256, size: r.size, blob: r.blob }))); }
  const originalRows = m.evidence.tables.rs_case_original!, previewRows = m.evidence.tables.rs_preview!;
  eq(m.originals, m.references.filter((r) => r.kind === 'original').map((r) => { const row = originalRows.find((x) => x.asset_id === r.assetId)!; return { assetId: r.assetId, filename: row.filename, mediaType: row.media_type, objectVersion: r.objectVersion, etag: r.etag, sha256: r.sha256, size: r.size, blob: r.blob }; }));
  eq(m.previews, m.references.filter((r) => r.kind === 'preview').map((r) => { const row = previewRows.find((x) => x.version_id === r.resultsVersion && x.asset_id === r.assetId)!; return { assetId: r.assetId, resultsVersion: r.resultsVersion, filename: row.filename, mediaType: row.media_type, objectVersion: r.objectVersion, etag: r.etag, sha256: r.sha256, size: r.size, blob: r.blob }; }));
  const p = m.evidence.tables.rs_publication![0];
  const published = p?.state === 'published' && !m.evidence.tables.rs_version_withdrawal!.some((r) => r.version_id === p.version_id);
  eq(m.source.publication, published ? { kind: 'published', resultsVersion: p.version_id } : { kind: p ? 'withdrawn' : 'none' });
  eq(m.source.activeVersion, published ? p.version_id : null);
  if (canonicalJson(m) !== decodeUtf8Strict(bytes)) bad();
  return m;
}

/** Checks actual package identity and original coverage against the sealed bytes, not just copied row claims. */
export async function verifyNativeBytes(m: NativeExportManifest, blobs: ReadonlyMap<string, Uint8Array>) {
  if (m.userWork) {
    const b = blobs.get(m.userWork.sha256); if (!b) missing();
    const snapshot = jsonBytes(b); exact(snapshot, ['format', 'exportedAt', 'tables']);
    if (snapshot.format !== 'clearcase.user-work/1' || snapshot.exportedAt !== m.userWork.exportedAt || !Array.isArray(snapshot.tables) || snapshot.tables.length !== m.userWork.tables) bad();
    let rows = 0;
    for (const table of snapshot.tables) {
      if (!obj(table) || table.kind !== 'user-work' || !Array.isArray(table.rows)) bad(); rows += table.rows.length;
      for (const row of table.rows) { if (!obj(row)) bad(); if ('case_id' in row && row.case_id !== m.caseId) throw fail('foreign-input'); }
    }
    if (rows !== m.userWork.rows) bad();
  }
  for (const version of m.resultsVersions) {
    const files = new Map(version.files.map((f) => [f.path, blobs.get(f.sha256)!]));
    const manifestBytes = files.get('manifest.json'); if (!manifestBytes) missing();
    const pkg = jsonBytes(manifestBytes);
    if (!obj(pkg) || !obj(pkg.case) || pkg.case.id !== m.caseId || pkg.resultsVersion !== version.version.id || !obj(pkg.inputRevision) || pkg.inputRevision.id !== version.version.input_revision_id || await sha256Hex(manifestBytes) !== version.version.manifest_sha256 || !Array.isArray(pkg.files)) bad();
    if (pkg.format !== 'clearcase.results-package' || pkg.formatVersion !== 1 || !Array.isArray(pkg.inputRevision.sources)) bad();
    const declared = pkg.files as Record<string, unknown>[];
    if (declared.some((f) => !obj(f) || !text(f.path) || !text(f.role) || !SHA.test(String(f.sha256)) || !Number.isSafeInteger(f.size) || Number(f.size) < 0)) bad();
    const cmp = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    const identities = declared.map((f) => ({ path: String(f.path), role: f.role, ...(f.key !== undefined ? { key: f.key } : {}), ...(f.kind !== undefined ? { kind: f.kind } : {}), sha256: f.sha256, size: f.size })).sort(cmp);
    if (`sha256:${await hash({ format: pkg.format, formatVersion: pkg.formatVersion, caseId: m.caseId, inputRevisionId: pkg.inputRevision.id, files: identities })}` !== version.version.id) bad();
    const sources = pkg.inputRevision.sources.map((s) => { if (!obj(s) || !text(s.role) || !SHA.test(String(s.sha256)) || !Number.isSafeInteger(s.size)) bad(); return { role: String(s.role), sha256: String(s.sha256), size: Number(s.size) }; })
      .sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : a.size - b.size);
    if (`sha256:${await hash(sources)}` !== pkg.inputRevision.id) bad();
    eq(version.files.filter((r) => r.path !== 'manifest.json').map(({ path, sha256, size }) => ({ path, sha256, size })).sort(cmp), declared.map((r) => ({ path: String(r.path), sha256: r.sha256, size: r.size })).sort(cmp));
    const assetsBytes = files.get('assets.json'); if (!assetsBytes) missing();
    const assets = jsonBytes(assetsBytes);
    exact(assets, ['index', 'root', 'assets']); if (assets.index !== 'clearcase.assets/1' || assets.root !== 'case-folder' || !obj(assets.assets)) bad();
    const assetMap = assets.assets;
    const c = m.evidence.tables.native_candidate!.find((r) => r.results_version === version.version.id)!;
    const l = m.evidence.tables.native_import_link!.find((r) => r.candidate_id === c.candidate_id)!;
    const parent = c.origin === 'correction' ? m.evidence.tables.native_candidate!.find((r) => r.candidate_id === c.parent_candidate_id) : null;
    if (parent && pkg.parent !== parent.results_version) bad();
    const coverage = json(String(l.coverage_json)) as { mappedOriginals: { packageRefs: string[]; packagePath: string; sha256: string; size: number }[]; unavailableOriginals: { kind: string; ref: string; path?: string; parentRef?: string }[] };
    const covered = new Set<string>();
    for (const mapping of coverage.mappedOriginals) for (const ref of mapping.packageRefs) {
      const asset = assetMap[ref]; if (!obj(asset) || asset.kind !== 'file' || asset.path !== mapping.packagePath || asset.sha256 !== mapping.sha256 || asset.size !== mapping.size || covered.has(ref)) bad(); covered.add(ref);
    }
    for (const u of coverage.unavailableOriginals) {
      const asset = assetMap[u.ref]; if (!obj(asset) || asset.kind !== u.kind || (u.kind === 'missing' ? asset.path !== u.path : asset.parentRef !== u.parentRef) || covered.has(u.ref)) bad(); covered.add(u.ref);
    }
    if (Object.keys(assetMap).length !== covered.size) bad();
  }
}

export interface NativeVerified extends Verified { sealedManifest: Uint8Array; nativeManifest: NativeExportManifest }
export async function loadNativeExport(deps: RecoveryDeps, req: VerifyRequest, scopesFor: (c: CaseId) => Parameters<typeof authorizeAndAudit>[1]['scopes'] = exportScopes, action = 'recovery.verify'): Promise<NativeVerified & { caseId: CaseId }> {
  const port = nativePort(deps), objects = requireObjects(deps), caseId = requireCaseId(req.caseId);
  if (!ID.test(req.exportId) || !SHA.test(req.expectedManifestSha256)) throw fail('invalid-request');
  const audit = { action, objectKind: 'case-export', objectId: req.exportId, caseId };
  await authorizeAndAudit(deps, { ...audit, scopes: scopesFor(caseId) });
  try {
    const keys = objectKeys(deps.identity.clientId, caseId, req.exportId);
    const beforeManifest = () => requireAuditView(deps, caseId);
    await beforeManifest();
    const sealedManifest = await objects.get(keys.manifest, { beforeRead: beforeManifest }); if (!sealedManifest) missing();
    const manifestSha256 = await sha256Hex(sealedManifest); if (manifestSha256 !== req.expectedManifestSha256) throw fail('manifest-mismatch');
    const nativeManifest = await parseNativeManifest(sealedManifest, port.limits);
    if (nativeManifest.clientId !== deps.identity.clientId || nativeManifest.caseId !== caseId || nativeManifest.exportId !== req.exportId) throw fail('foreign-input');
    const manifest = legacyView(nativeManifest);
    const beforeRead = () => recheckNative(deps, nativeManifest, scopesFor(caseId));
    await beforeRead(); // before any retained protected blob is read
    const refs = [...nativeManifest.references, ...(manifest.userWork ? [manifest.userWork] : [])];
    if (refs.length > port.limits.maxFiles || refs.some((r) => r.size > port.limits.maxFileBytes) || refs.reduce((n, r) => n + r.size, 0) > port.limits.maxTotalBytes) throw fail('export-too-large');
    const blobs = new Map<string, Uint8Array>();
    for (const r of refs) {
      if (blobs.has(r.sha256)) { if (blobs.get(r.sha256)!.length !== r.size) bad(); continue; }
      await beforeRead();
      const b = await objects.get(`${keys.base}/${r.blob}`, { beforeRead }); if (!b) missing();
      if (b.length !== r.size || await sha256Hex(b) !== r.sha256) throw fail('export-corrupt'); blobs.set(r.sha256, b);
    }
    await verifyNativeBytes(nativeManifest, blobs);
    await recheckNative(deps, nativeManifest, scopesFor(caseId));
    return { manifest, nativeManifest, sealedManifest, manifestSha256, blobs, accounting: manifest.accounting, caseId };
  } catch (e) { await recordFailure(deps, audit, e); throw e; }
}
export async function verifyNativeExport(deps: RecoveryDeps, req: VerifyRequest) {
  const v = await loadNativeExport(deps, req);
  await recordAfter(deps, { action: 'recovery.verify', objectKind: 'case-export', objectId: req.exportId, caseId: v.caseId, outcome: 'succeeded' });
  await recheckNative(deps, v.nativeManifest, exportScopes(v.caseId));
  return { manifest: v.nativeManifest, manifestSha256: v.manifestSha256, accounting: v.accounting, verifiedBlobs: v.blobs.size };
}
