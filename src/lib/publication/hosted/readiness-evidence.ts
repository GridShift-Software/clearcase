import type { CaseId, ClientId } from '../../server/runtime/contracts.ts';
import { d1EvidenceStore, verifyEvidence, type EvidenceBinding, type EvidenceD1 } from './evidence/index.ts';
import type { EvidenceCountGroup, EvidenceItemRow, EvidenceKind, EvidenceReader } from './ports.ts';

// The D1 side of snapshot v2 readiness: it reads what a finished evidence build stored (`evidence/`) and builds, hashes and
// recomputes nothing. Counts are one GROUP BY over the run's rows; a page is one keyset range over the primary key, so the cost of a
// page does not grow with the number of items before it. Every item key is `<kind>/<subject>` (`rules.ts`), which makes a kind a
// contiguous range: `warning/` up to `warning0` ('0' follows '/'), and the whole run is `''` up to DEL, above every permitted key.
const END = '\u007f';
const range = (kind: EvidenceKind | null): [string, string] => kind ? [`${kind}/`, `${kind}0`] : ['', END];
const COMPLETE = `r.candidate_id = ? AND r.generation = ? AND r.client_id = ? AND r.case_id = ? AND r.state = 'complete'`;
// The rows the run's seal covers, evaluated inside the reading statement so a row inserted after sealing (nothing in the schema stops
// one) cannot be served: the stored item rows are exactly the items of the sealed pages, the greatest key is the one the build ended on,
// and the page count is the sealed one. The same facts `verifyEvidence` checks, from the same columns, without hashing anything.
const SEALED = `json_extract(r.cursor, '$.done') = 1 AND json_extract(r.cursor, '$.inPage') = 0
  AND (SELECT count(*) FROM pub_evidence_item WHERE candidate_id = r.candidate_id AND generation = r.generation)
    = (SELECT coalesce(sum(item_count), 0) FROM pub_evidence_page WHERE candidate_id = r.candidate_id AND generation = r.generation)
  AND (SELECT max(item_key) FROM pub_evidence_item WHERE candidate_id = r.candidate_id AND generation = r.generation) IS json_extract(r.cursor, '$.last')
  AND (SELECT count(*) FROM pub_evidence_page WHERE candidate_id = r.candidate_id AND generation = r.generation) = json_extract(r.cursor, '$.pages')`;
type Row = Record<string, string | number | null>;

export interface EvidenceSummary { readonly root: string; readonly items: number; readonly groups: EvidenceCountGroup[]; readonly newWarnings: number }
export interface D1EvidenceReader extends EvidenceReader {
  /**
   * The root, the item total, the counts and the number of warnings the case's baseline does not hold, for a completed run: what a
   * candidate reader puts in a v2 snapshot. Null when the run is missing, belongs to another client or case, is not complete, or its
   * stored rows are not exactly what its sealed pages cover (`verifyEvidence`).
   */
  summary(a: { clientId: ClientId; caseId: CaseId; candidateId: string; generation: string }): Promise<EvidenceSummary | null>;
}

const order = (a: EvidenceCountGroup, b: EvidenceCountGroup): number => {
  for (const [x, y] of [[a.kind, b.kind], [a.subject ?? '', b.subject ?? ''], [a.state ?? '', b.state ?? ''], [a.reason ?? '', b.reason ?? '']] as const) if (x !== y) return x < y ? -1 : 1;
  return 0;
};

export function d1EvidenceReader(d1: EvidenceD1): D1EvidenceReader {
  const db = () => d1.withSession('first-primary');
  return {
    async page(a) {
      const [from, to] = range(a.kind), session = db();
      const where = [a.candidateId, a.generation, a.clientId, a.caseId];
      const { results } = await session.prepare(
        `SELECT i.item_key AS key, i.item_json AS json,
           CASE WHEN i.item_key >= 'warning/' AND i.item_key < 'warning0'
             THEN EXISTS (SELECT 1 FROM rs_trusted_fingerprint t WHERE t.case_id = r.case_id AND t.fingerprint = json_extract(i.item_json, '$.observation.fingerprint')) END AS baseline
         FROM pub_evidence_run r JOIN pub_evidence_item i ON i.candidate_id = r.candidate_id AND i.generation = r.generation
         WHERE ${COMPLETE} AND r.evidence_root = ? AND ${SEALED} AND i.item_key > ? AND i.item_key >= ? AND i.item_key < ?
         ORDER BY i.item_key LIMIT ?`)
        .bind(...where, a.root, a.after ?? '', from, to, a.limit).all<Row>();
      if (results.length === 0) {
        // An empty page is the end of the range, unless there is no such run at all.
        const run = await session.prepare(`SELECT 1 AS found FROM pub_evidence_run r WHERE ${COMPLETE} AND r.evidence_root = ? AND ${SEALED}`).bind(...where, a.root).first<{ found: number }>();
        return run ? [] : null;
      }
      return results.map((r): EvidenceItemRow => ({ key: r.key as string, json: r.json as string, baseline: r.baseline === null ? null : r.baseline === 1 }));
    },

    async summary(a) {
      const session = db(), where = [a.candidateId, a.generation, a.clientId, a.caseId];
      const run = await session.prepare(
        `SELECT client_id, case_id, results_version, manifest_sha256, validator_version, renderer_version FROM pub_evidence_run r WHERE ${COMPLETE}`)
        .bind(...where).first<Row>();
      if (!run) return null;
      const binding: EvidenceBinding = { candidateId: a.candidateId, generation: a.generation, clientId: run.client_id as string, caseId: run.case_id as string, resultsVersion: run.results_version as string,
        manifestSha256: run.manifest_sha256 as string, validatorVersion: run.validator_version as string, rendererVersion: run.renderer_version as string };
      const sealed = await verifyEvidence(d1EvidenceStore(d1), binding);
      if (!sealed.ok) return null;
      const { results } = await session.prepare(
        `SELECT kind, CASE WHEN kind = 'section' THEN item END AS subject, state, reason, count(*) AS count FROM (
           SELECT json_extract(item_json, '$.observation.kind') AS kind, json_extract(item_json, '$.observation.key') AS item,
             json_extract(item_json, '$.observation.state') AS state, json_extract(item_json, '$.observation.reasonCode') AS reason
           FROM pub_evidence_item WHERE candidate_id = ? AND generation = ?)
         GROUP BY kind, subject, state, reason`).bind(a.candidateId, a.generation).all<Row>();
      const groups = results.map((r): EvidenceCountGroup => ({ kind: r.kind as EvidenceKind, subject: r.subject as string | null, state: r.state as string | null, reason: r.reason as string | null, count: r.count as number }))
        .sort(order);
      const items = groups.reduce((n, g) => n + g.count, 0);
      if (items !== sealed.items) return null;
      const fresh = await session.prepare(
        `SELECT count(*) AS n FROM pub_evidence_item i WHERE i.candidate_id = ? AND i.generation = ? AND i.item_key >= 'warning/' AND i.item_key < 'warning0'
           AND NOT EXISTS (SELECT 1 FROM rs_trusted_fingerprint t WHERE t.case_id = ? AND t.fingerprint = json_extract(i.item_json, '$.observation.fingerprint'))`)
        .bind(a.candidateId, a.generation, a.caseId).first<{ n: number }>();
      return { root: sealed.root, items, groups, newWarnings: fresh?.n ?? 0 };
    },
  };
}
