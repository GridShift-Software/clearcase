import type { CaseId, ClientId } from '../../server/runtime/contracts.ts';
import { codeOf, contractError } from '../../server/runtime/errors.ts';
import type { PublicationD1 } from './ledger.ts';
import type { AtomicPublicationMutation, CheckedEvidenceRows, PointerOutcome, PublicationApplyReceipt, PublicationIntent, PublicationState, StoragePublisher } from './ports.ts';

/** The real binding, NOT a read-replica session. Each receipt/revision read starts on the primary. */
export interface PublicationD1Database {
  withSession(constraint: 'first-primary'): PublicationD1;
}
export interface D1PublicationOptions {
  readonly db: PublicationD1Database;
  /** Trusted deployment configuration, never a request field. Checked against rs_storage_identity in SQL too. */
  readonly clientId: ClientId;
  /**
   * Required fresh check of the CURRENT retry session (including expiry/revocation), not JWT verification alone.
   * The parent closes over this request's verified Identity, checks its principal/session match, then invokes
   * Identity.checkRevocation(). Called after recheck(), immediately before submitting the guarded D1 batch.
   * Known session denials return guard-refused; faults reject. No generic identity, role allow or cached verdict is supplied here.
   */
  checkSession(authority: AtomicPublicationMutation['authority']): Promise<void>;
}

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(',')}}`;
}
function decode(value: unknown): PublicationApplyReceipt {
  if (typeof value !== 'string') return unavailable();
  try {
    const intent = JSON.parse(value) as PublicationIntent;
    if (!intent || typeof intent !== 'object' || typeof intent.operationId !== 'string' || !intent.auditEvent) return unavailable();
    return { intent };
  } catch { return unavailable(); }
}
const same = (a: PublicationIntent, b: PublicationIntent) => canonical(a) === canonical(b);

// Snapshot v2 (real-export design 2): the pointer is written only while the sign-off's evidence row, the sealed run it names and the
// rows that run holds still agree, decided in the same transaction as the write. A guard that fails inserts nothing; no trigger names it.
// This is the metadata half of `verifyEvidence` in SQL: the run is complete, bound to the sign-off's candidate, results version and
// manifest, carries the signed root, and holds exactly the rows its pages cover with the greatest key its build ended on. The
// recomputation of the root from the rows themselves is the controller's recheck, made BEFORE this batch and outside it; the batch
// therefore also carries the rows that recheck hashed and compares them with the stored ones (`rowGuards`), in the same transaction.
// The signed generation must also still be the candidate's latest: a restart that begins after the recheck writes a newer run row
// (building or sealed), and from then on readiness serves only that one, so the older sign-off is stale here too (U14 review H1).
const EVIDENCE_GUARD = `WHERE EXISTS (
  SELECT 1 FROM pub_signoff s
  JOIN pub_signoff_evidence e ON e.signoff_id = s.signoff_id AND e.candidate_id = s.candidate_id
  JOIN pub_evidence_run r ON r.candidate_id = e.candidate_id AND r.generation = e.generation
  WHERE s.signoff_id = ? AND s.client_id = ? AND s.case_id = ? AND e.generation = ? AND e.evidence_root = ?
    AND r.state = 'complete' AND r.evidence_root = e.evidence_root AND r.client_id = s.client_id AND r.case_id = s.case_id
    AND r.results_version = s.results_version AND r.manifest_sha256 = s.manifest_sha256
    AND json_extract(r.cursor, '$.done') = 1 AND json_extract(r.cursor, '$.inPage') = 0
    AND json_extract(r.cursor, '$.pages') = (SELECT count(*) FROM pub_evidence_page p WHERE p.candidate_id = r.candidate_id AND p.generation = r.generation)
    AND (SELECT count(*) FROM pub_evidence_item i WHERE i.candidate_id = r.candidate_id AND i.generation = r.generation)
      = (SELECT coalesce(sum(p.item_count), 0) FROM pub_evidence_page p WHERE p.candidate_id = r.candidate_id AND p.generation = r.generation)
    AND (SELECT max(i.item_key) FROM pub_evidence_item i WHERE i.candidate_id = r.candidate_id AND i.generation = r.generation) IS json_extract(r.cursor, '$.last')
    AND NOT EXISTS (SELECT 1 FROM pub_evidence_run n WHERE n.candidate_id = r.candidate_id AND n.generation <> r.generation
      AND CAST(n.generation AS INTEGER) >= CAST(r.generation AS INTEGER)))`;


// SQLite has no digest function, so the commit cannot rehash the rows. It compares them instead: the recheck's exact [key, json] pairs
// go in as bound JSON, chunked so no statement binds more than one parameter or more than CHUNK_BYTES of rows, however many items the
// run holds (the 100-bound-parameter and statement-size limits of D1 never apply). Any difference makes `json()` fail, which aborts the
// whole batch (D1 rolls back every statement of a failed batch), so neither the receipt nor the pointer is written. The pairs are
// checked against the sign-off's own evidence row, and the stored count must equal the pairs' count, so no row can be changed,
// removed or added. Nothing here depends on the seal triggers, which a corrupted or restored database may lack.
const CHUNK_BYTES = 64_000;
const ABORT = 'malformed JSON'; // what SQLite says when `json('pub:signoff-stale')` fails; D1 wraps it, so match by inclusion
const abortUnless = (ok: string) => `SELECT json(CASE WHEN ${ok} THEN '0' ELSE 'pub:signoff-stale' END)`;
const bytes = new TextEncoder();
function rowGuards(primary: PublicationD1, checked: CheckedEvidenceRows) {
  const chunks: (readonly [string, string])[][] = [[]];
  let size = 0;
  for (const row of checked.rows) {
    const n = bytes.encode(row[0]).length + bytes.encode(row[1]).length + 16;
    if (size + n > CHUNK_BYTES && chunks[chunks.length - 1]!.length) { chunks.push([]); size = 0; }
    chunks[chunks.length - 1]!.push(row); size += n;
  }
  return [
    primary.prepare(abortUnless(`(SELECT count(*) FROM pub_signoff_evidence e JOIN pub_evidence_item i ON i.candidate_id = e.candidate_id AND i.generation = e.generation
      WHERE e.signoff_id = ?) = ?`)).bind(checked.signoffId, checked.rows.length),
    ...chunks.map((chunk) => primary.prepare(abortUnless(`NOT EXISTS (SELECT 1 FROM json_each(?) c JOIN pub_signoff_evidence e ON e.signoff_id = ?
      LEFT JOIN pub_evidence_item i ON i.candidate_id = e.candidate_id AND i.generation = e.generation AND i.item_key = json_extract(c.value, '$[0]')
      WHERE i.item_key IS NULL OR i.item_json IS NOT json_extract(c.value, '$[1]'))`)).bind(JSON.stringify(chunk), checked.signoffId)),
  ];
}

/**
 * SQL, not a process lock, serializes the current grant, sign-off, candidate generation, expected pointer and receipt.
 * Migration 0002_atomic_publication.sql owns those predicates and the pointer-writing receipt trigger.
 *
 * AUTHORIZATION BOUNDARY: recheck and the final external session check run BEFORE the D1 transaction, never inside an
 * imaginary D1/Clerk transaction. D1 grant revocation and locally recorded session revocation are serialized with the
 * mutation. Clerk revocation AFTER the final successful check can race the commit. The parent's literal global-lock
 * wording in atomic-publication/1 MUST be corrected before composition; see docs/acceptance/atomic-d1-publication.md.
 * A v2 publish's recheck hashes the evidence rows outside the transaction; it returns those rows and the transaction compares them.
 */
export function d1PublicationPublisher(options: D1PublicationOptions): StoragePublisher {
  const { db, clientId, checkSession } = options;
  if (!clientId || typeof db?.withSession !== 'function' || typeof checkSession !== 'function') return unavailable();

  async function receipt(a: { clientId: ClientId; caseId: CaseId; operationId: string }): Promise<PublicationApplyReceipt | null> {
    if (a.clientId !== clientId) return unavailable();
    const row = await db.withSession('first-primary').prepare(`SELECT r.intent_json FROM pub_apply_receipt r
      JOIN rs_storage_identity i ON i.singleton = 1 AND i.client_id = r.client_id AND i.layout = 'clearcase.rs/1'
      WHERE r.client_id = ? AND r.case_id = ? AND r.operation_id = ?`)
      .bind(clientId, a.caseId, a.operationId).first<{ intent_json: string }>();
    return row ? decode(row.intent_json) : null;
  }
  async function current(caseId: CaseId): Promise<PublicationState> {
    const row = await db.withSession('first-primary').prepare('SELECT state, version_id FROM rs_publication WHERE case_id = ?')
      .bind(caseId).first<{ state: 'published' | 'withdrawn'; version_id: PublicationIntent['resultsVersion'] }>();
    return row ? { kind: row.state, resultsVersion: row.version_id } : { kind: 'none' };
  }
  async function mutate(kind: 'publish' | 'withdraw', mutation: AtomicPublicationMutation): Promise<PointerOutcome> {
    // Freeze caller-owned objects before any await. A callback cannot change the committed intent/authority in place.
    const intent = structuredClone(mutation.intent), authority = structuredClone(mutation.authority);
    Object.freeze(authority.principal); Object.freeze(authority);
    if (intent.kind !== kind || intent.clientId !== clientId || authority.clientId !== clientId || authority.caseId !== intent.caseId || authority.capability !== 'publish'
      || canonical(authority.principal) !== canonical(intent.actor) || !authority.sessionId) return { kind: 'guard-refused', reason: 'forbidden' };
    const key = { clientId, caseId: intent.caseId, operationId: intent.operationId };
    const prior = await receipt(key);
    if (prior) return same(prior.intent, intent) ? { kind: 'applied', repeated: true } : { kind: 'refused', reason: 'intent-mismatch' };

    const primary = db.withSession('first-primary');
    const evidence = kind === 'publish' ? intent.signedIdentity?.evidence : undefined;
    const receiptValues = [intent.operationId, clientId, intent.caseId, canonical(intent), authority.principal.issuer, authority.principal.subject, authority.principal.kind, authority.sessionId];
    const insert = evidence && intent.signoffId
      ? primary.prepare(`INSERT INTO pub_apply_receipt
      (operation_id, client_id, case_id, intent_json, authority_issuer, authority_subject, authority_kind, authority_session_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? ${EVIDENCE_GUARD}`).bind(...receiptValues, intent.signoffId, clientId, intent.caseId, evidence.generation, evidence.root)
      : primary.prepare(`INSERT INTO pub_apply_receipt
      (operation_id, client_id, case_id, intent_json, authority_issuer, authority_subject, authority_kind, authority_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(...receiptValues);
    const readback = primary.prepare('SELECT intent_json FROM pub_apply_receipt WHERE client_id = ? AND case_id = ? AND operation_id = ?')
      .bind(clientId, intent.caseId, intent.operationId);
    // Recheck errors are outside the storage catch. Preserve the controller's private Refusal object unchanged.
    const checked = await mutation.recheck();
    // A signed v2 publish with no rows to hold the commit to is refused, never committed on the metadata guard alone.
    if (evidence && (!checked || checked.signoffId !== intent.signoffId)) return { kind: 'guard-refused', reason: 'signoff-stale' };
    try {
      const checked: unknown = await checkSession(authority);
      if (checked === false) return { kind: 'guard-refused', reason: 'invalid-session' };
      if (checked !== undefined) return unavailable();
    } catch (error) {
      const code = codeOf(error);
      if (code === 'invalid-session' || code === 'unauthenticated' || code === 'wrong-client') return { kind: 'guard-refused', reason: 'invalid-session' };
      if (code === 'forbidden' || code === 'not-found') return { kind: 'guard-refused', reason: 'forbidden' };
      throw error;
    }
    try {
      const guards = evidence && checked ? rowGuards(primary, checked) : [];
      const result = await primary.batch([...guards, insert, readback]);
      const last = result[result.length - 1] as { results?: { intent_json?: unknown }[] } | undefined;
      if (evidence && !last?.results?.[0]) {
        // The guard inserted nothing. Another isolate may have won this very operation; otherwise the evidence moved after the recheck.
        const raced = await receipt(key);
        if (raced) return same(raced.intent, intent) ? { kind: 'applied', repeated: true } : { kind: 'refused', reason: 'intent-mismatch' };
        return { kind: 'guard-refused', reason: 'signoff-stale' };
      }
      const saved = decode(last?.results?.[0]?.intent_json);
      if (!same(saved.intent, intent)) return unavailable();
      return { kind: 'applied', repeated: false };
    } catch (error) {
      // An acknowledgement may be lost AFTER commit, or another isolate may have won the same operation. Only this
      // operation's durable, exact receipt is proof. Pointer equality is never used, even for a no-op publication.
      const saved = await receipt(key);
      if (saved) return same(saved.intent, intent) ? { kind: 'applied', repeated: true } : { kind: 'refused', reason: 'intent-mismatch' };
      const message = error instanceof Error ? error.message : '';
      if (message.includes('pub:forbidden')) return { kind: 'guard-refused', reason: 'forbidden' };
      if (message.includes('pub:invalid-session')) return { kind: 'guard-refused', reason: 'invalid-session' };
      if (message.includes('pub:signoff-stale') || (evidence && message.includes(ABORT))) return { kind: 'guard-refused', reason: 'signoff-stale' };
      if (message.includes('pub:pointer-conflict')) return { kind: 'conflict', current: await current(intent.caseId) };
      if (message.includes('pub:intent-mismatch')) return { kind: 'refused', reason: 'intent-mismatch' };
      if (message.includes('pub:version-refused')) return { kind: 'refused', reason: 'version-unavailable' };
      return unavailable();
    }
  }
  return { protocol: 'atomic-publication/1', receipt, publish: (a) => mutate('publish', a), withdraw: (a) => mutate('withdraw', a) };
}

/**
 * Parent CandidateReader hook. Read this BEFORE and AFTER assembling a snapshot on the same client DB; refuse an
 * absent or changed revision, otherwise return it as snapshotRevision. The migration advances it and permanently
 * invalidates old sign-offs on every tracked dependency write, even if the dependency is subsequently restored.
 * Missing migration, an unlinked/superseded candidate or a crossed DB never yields a usable revision.
 */
export async function d1PublicationSnapshotRevision(db: PublicationD1Database, a: { clientId: ClientId; caseId: CaseId; candidateId: string }): Promise<string | null> {
  const row = await db.withSession('first-primary').prepare(`SELECT 'd1:' || g.generation AS revision FROM pub_candidate_generation g
    JOIN rs_storage_identity i ON i.singleton = 1 AND i.client_id = g.client_id AND i.layout = 'clearcase.rs/1'
    WHERE g.client_id = ? AND g.case_id = ? AND g.candidate_id = ?
      AND EXISTS (SELECT 1 FROM native_candidate_audit_intent ai JOIN native_candidate_audit_settlement ats
        ON ats.client_id = ai.client_id AND ats.case_id = ai.case_id AND ats.candidate_id = ai.candidate_id AND ats.event_id = ai.event_id
        WHERE ai.client_id = g.client_id AND ai.case_id = g.case_id AND ai.candidate_id = g.candidate_id)
      AND NOT EXISTS (SELECT 1 FROM native_candidate_supersession s WHERE s.client_id = g.client_id AND s.case_id = g.case_id AND s.old_candidate_id = g.candidate_id)`)
    .bind(a.clientId, a.caseId, a.candidateId).first<{ revision: string }>();
  return row?.revision ?? null;
}
