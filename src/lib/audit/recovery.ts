import type { AuditEvent, AuditSink } from '../server/runtime/contracts.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import { contractError } from '../server/runtime/errors.ts';
import { parseStrictJson } from '../case-package/strict-json.ts';
import { d1NativeCandidateRepository } from '../results-review/native/repository.ts';
import type { CandidateAuditRecovery, CommittedCandidateAudit } from '../results-review/native/ports.ts';
import type { AuditConfig } from './config.ts';
import { committedDeliveryCore } from './d1-log.ts';
import { canonical, sha256Hex, validCaseId } from './event.ts';

/** Raw same-client D1 binding, never a replica session or a caller-supplied source reader. */
export interface RecoveryD1 extends D1 { withSession(constraint: 'first-primary'): D1 }
export interface CommittedAuditRecovery {
  readonly candidate: CandidateAuditRecovery;
  readonly publication: Readonly<AuditSink>;
}
type Args = { db: RecoveryD1; config: AuditConfig; now: () => Date };
const invalid = (): never => { throw contractError('invalid-event'); };
const unavailable = (): never => { throw contractError('audit-unavailable', true); };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parse(text: string): unknown {
  try { return parseStrictJson(text); } catch { return invalid(); }
}
type PublicationSource = {
  client_id: string; case_id: string; source_id: string; operation_id: string; results_version: string;
  issuer: string; subject: string; principal_kind: 'staff' | 'client'; at: string; audit_event: string;
  kind?: 'publish' | 'withdraw'; state?: string; intent_json?: string; durable_intent?: string;
};

/** Check the event against immutable columns as well as the retained envelope (including its original session). */
async function publicationEvent(row: PublicationSource, action: string): Promise<AuditEvent> {
  const event = parse(row.audit_event) as AuditEvent;
  if (event?.actor?.kind !== 'verified' || typeof event.actor.sessionId !== 'string') return invalid();
  const expected = {
    eventId: `${action.replace('.', '-')}-${row.source_id}-${(await sha256Hex(event.actor.sessionId)).slice(0, 12)}`.slice(0, 128),
    actor: { kind: 'verified', principal: { issuer: row.issuer, subject: row.subject, kind: row.principal_kind }, sessionId: event.actor.sessionId },
    action, object: { kind: 'publication', id: row.source_id, caseId: row.case_id },
    version: row.results_version, outcome: 'succeeded', at: row.at,
  };
  if (canonical(event) !== canonical(expected)) return invalid();
  return event;
}

/**
 * TRUSTED COMPOSITION ONLY: the hosted services composer is the sole external importer (the existing source-graph
 * barrier restricts all audit construction). No generic append/find/query or event factory escapes this module.
 * Inputs are lookup hints, never proof. Every delivery reloads immutable provenance on the primary and the internal
 * producer compares the complete canonical envelope before appending. Acknowledgement requires exact audit readback.
 * This does not enumerate, settle, authorize, sign off, apply or publish anything.
 */
export function committedAuditRecovery({ db, config, now }: Args): CommittedAuditRecovery {
  if (typeof db?.withSession !== 'function') throw new TypeError('committed audit recovery requires the raw D1 binding');

  async function primary(): Promise<D1> {
    const session = db.withSession('first-primary');
    const row = await session.prepare("SELECT client_id FROM rs_storage_identity WHERE singleton = 1 AND layout = 'clearcase.rs/1'")
      .first<{ client_id: string }>().catch(unavailable);
    if (row?.client_id !== config.clientId) return unavailable();
    return session;
  }
  const candidate: CandidateAuditRecovery = Object.freeze({ async appendCommitted(input: CommittedCandidateAudit) {
    // Snapshot caller-owned scope and event before the first await, including across an asynchronous source read.
    const intent = structuredClone(input);
    if (intent?.clientId !== config.clientId || !validCaseId(intent.caseId) || typeof intent.candidateId !== 'string' || !ID.test(intent.candidateId)) return invalid();
    const session = await primary();
    const delivery = committedDeliveryCore({ db: session, config, now }, async () => {
      // The real repository checks link/candidate identity, canonical event JSON, SHA-256, event id and the exact
      // origin/link/operator/time/session-derived event. Supersession does not erase a committed historical fact.
      const saved = await d1NativeCandidateRepository(session).auditIntent({ clientId: config.clientId, caseId: intent.caseId, candidateId: intent.candidateId });
      return saved.event;
    });
    return delivery.append(intent.event);
  } });

  const publication: AuditSink = Object.freeze({ async append(input: AuditEvent) {
    const event = structuredClone(input);
    const session = await primary();
    const delivery = committedDeliveryCore({ db: session, config, now }, async (hint) => {
      const caseId = hint.object.caseId, sourceId = hint.object.id;
      if (!validCaseId(caseId) || !ID.test(sourceId) || hint.object.kind !== 'publication') return invalid();
      if (hint.action === 'publication.signoff') {
        const row = await session.prepare(`SELECT s.client_id, s.case_id, s.signoff_id AS source_id, s.operation_id, s.results_version,
          s.signer_issuer AS issuer, s.signer_subject AS subject, s.signer_kind AS principal_kind, s.signed_at AS at, s.audit_event
          FROM pub_signoff s
          JOIN native_candidate c ON c.client_id = s.client_id AND c.case_id = s.case_id AND c.candidate_id = s.candidate_id
          JOIN native_import_link l ON l.client_id = c.client_id AND l.case_id = c.case_id AND l.candidate_id = c.candidate_id
          WHERE s.client_id = ? AND s.case_id = ? AND s.signoff_id = ?
            AND s.link_id = l.link_id AND s.submission_revision_id = l.submission_revision_id
            AND s.submission_manifest_sha256 = l.submission_manifest_sha256 AND s.results_version = c.results_version
            AND s.manifest_sha256 = c.manifest_sha256 AND s.package_input_revision_id = c.input_revision_id
            AND s.prepared_by_issuer = l.operator_issuer AND s.prepared_by_subject = l.operator_subject`)
          .bind(config.clientId, caseId, sourceId).first<PublicationSource>().catch(unavailable);
        if (!row || row.source_id !== `so-${row.operation_id}`) return invalid();
        // An invalidated sign-off still happened. Delivery cannot make it current or clear invalidation.
        return publicationEvent(row, 'publication.signoff');
      }
      if (hint.action !== 'publication.publish' && hint.action !== 'publication.withdraw') return invalid();
      const row = await session.prepare(`SELECT o.client_id, o.case_id, o.operation_id AS source_id, o.operation_id, o.results_version,
        o.actor_issuer AS issuer, o.actor_subject AS subject, o.actor_kind AS principal_kind, o.at, o.audit_event, o.kind, o.state,
        r.intent_json, d.intent_json AS durable_intent
        FROM pub_operation o
        JOIN pub_apply_receipt r ON r.client_id = o.client_id AND r.case_id = o.case_id AND r.operation_id = o.operation_id
        JOIN pub_durable_intent d ON d.client_id = o.client_id AND d.case_id = o.case_id AND d.operation_id = o.operation_id
        WHERE o.client_id = ? AND o.case_id = ? AND o.operation_id = ?`)
        .bind(config.clientId, caseId, sourceId).first<PublicationSource>().catch(unavailable);
      if (!row || row.state === 'refused' || hint.action !== `publication.${row.kind}` || !row.intent_json || !row.durable_intent
        || canonical(parse(row.intent_json)) !== canonical(parse(row.durable_intent))) return invalid();
      // A pending/failed outcome with a receipt is committed; an applied label/current pointer without one is NOT.
      return publicationEvent(row, `publication.${row.kind}`);
    });
    return delivery.append(event);
  } });
  return Object.freeze({ candidate, publication });
}
