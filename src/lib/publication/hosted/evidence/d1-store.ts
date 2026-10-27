// D1 side of the evidence build. Every write is one batch whose statements are all conditional on the same guard: the run is
// still building, this builder holds its lease token, and the cursor is the one this builder read. A builder that lost the lease,
// or raced another that shares its id, therefore changes nothing. Items are inserted as one statement from a JSON array
// (json_each) so a step costs a constant number of D1 queries, not one per item.
import type { PublicationD1 } from '../ledger.ts';
import type { EvidenceBinding, EvidenceClaim, EvidencePage, EvidenceStore } from './types.ts';

/** The part of a D1 binding the store uses. The parent passes the client's per-deployment `DB`. */
export interface EvidenceD1 { withSession(constraint: 'first-primary'): PublicationD1 }

type Value = string | number | null;
const changes = (result: unknown): number => (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
const GUARD = `EXISTS (SELECT 1 FROM pub_evidence_run WHERE candidate_id = ? AND generation = ? AND state = 'building' AND lease_token = ? AND cursor IS ?)`;
const RUN_WHERE = `candidate_id = ? AND generation = ? AND state = 'building' AND lease_token = ? AND cursor IS ?`;

export function d1EvidenceStore(d1: EvidenceD1): EvidenceStore {
  const db = () => d1.withSession('first-primary');
  const guard = (b: EvidenceBinding, leaseId: string, cursor: string | null): Value[] => [b.candidateId, b.generation, leaseId, cursor];
  const pageStatement = (session: PublicationD1, b: EvidenceBinding, page: EvidencePage, g: Value[]) => session.prepare(
    `INSERT INTO pub_evidence_page (candidate_id, generation, page_number, page_sha256, item_count) SELECT ?, ?, ?, ?, ? WHERE ${GUARD}`)
    .bind(b.candidateId, b.generation, page.number, page.sha256, page.itemCount, ...g);

  return {
    async claim(b, leaseId, nowMs, leaseUntilMs): Promise<EvidenceClaim> {
      const session = db();
      const claimed = await session.prepare(
        `INSERT INTO pub_evidence_run (candidate_id, generation, client_id, case_id, results_version, manifest_sha256, validator_version, renderer_version, state, cursor, lease_token, lease_until_ms, evidence_root)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'building', NULL, ?, ?, NULL)
         ON CONFLICT (candidate_id, generation) DO UPDATE SET lease_token = excluded.lease_token, lease_until_ms = excluded.lease_until_ms
         WHERE pub_evidence_run.state = 'building' AND pub_evidence_run.client_id = excluded.client_id AND pub_evidence_run.case_id = excluded.case_id
           AND pub_evidence_run.results_version = excluded.results_version AND pub_evidence_run.manifest_sha256 = excluded.manifest_sha256
           AND pub_evidence_run.validator_version = excluded.validator_version AND pub_evidence_run.renderer_version = excluded.renderer_version
           AND (pub_evidence_run.lease_token IS NULL OR pub_evidence_run.lease_token = excluded.lease_token OR pub_evidence_run.lease_until_ms <= ?)
         RETURNING cursor`)
        .bind(b.candidateId, b.generation, b.clientId, b.caseId, b.resultsVersion, b.manifestSha256, b.validatorVersion, b.rendererVersion, leaseId, leaseUntilMs, nowMs)
        .first<{ cursor: string | null }>();
      if (claimed) return { kind: 'claimed', cursor: claimed.cursor };
      const run = await session.prepare(`SELECT client_id, case_id, results_version, manifest_sha256, validator_version, renderer_version, state, evidence_root FROM pub_evidence_run WHERE candidate_id = ? AND generation = ?`)
        .bind(b.candidateId, b.generation).first<{ client_id: string; case_id: string; results_version: string; manifest_sha256: string; validator_version: string; renderer_version: string; state: string; evidence_root: string | null }>();
      if (!run) return { kind: 'leased' };
      if (run.client_id !== b.clientId || run.case_id !== b.caseId || run.results_version !== b.resultsVersion || run.manifest_sha256 !== b.manifestSha256
        || run.validator_version !== b.validatorVersion || run.renderer_version !== b.rendererVersion) return { kind: 'binding-mismatch' };
      return run.state === 'complete' && run.evidence_root ? { kind: 'complete', root: run.evidence_root } : { kind: 'leased' };
    },

    async commit(b, leaseId, expect, write) {
      const session = db(), g = guard(b, leaseId, expect.cursor);
      const statements = [];
      if (write.items.length > 0) statements.push(session.prepare(
        `INSERT INTO pub_evidence_item (candidate_id, generation, item_key, item_json) SELECT ?, ?, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(?) AS j WHERE ${GUARD}`)
        .bind(b.candidateId, b.generation, JSON.stringify(write.items.map(i => [i.key, i.json])), ...g));
      if (write.page) statements.push(pageStatement(session, b, write.page, g));
      statements.push(session.prepare(`UPDATE pub_evidence_run SET cursor = ?, lease_until_ms = ? WHERE ${RUN_WHERE}`).bind(write.nextCursor, write.leaseUntilMs, ...g));
      const results = await session.batch(statements);
      return changes(results[results.length - 1]) === 1;
    },

    async pages(b) {
      const { results } = await db().prepare(`SELECT page_sha256 FROM pub_evidence_page WHERE candidate_id = ? AND generation = ? ORDER BY page_number`).bind(b.candidateId, b.generation).all<{ page_sha256: string }>();
      return results.map(r => r.page_sha256);
    },

    async finish(b, leaseId, expect, write) {
      const session = db(), g = guard(b, leaseId, expect.cursor);
      const statements = [];
      if (write.page) statements.push(pageStatement(session, b, write.page, g));
      statements.push(session.prepare(`UPDATE pub_evidence_run SET state = 'complete', evidence_root = ?, cursor = ?, lease_token = NULL, lease_until_ms = NULL WHERE ${RUN_WHERE}`)
        .bind(write.root, write.nextCursor, ...g));
      const results = await session.batch(statements);
      return changes(results[results.length - 1]) === 1;
    },
  };
}
