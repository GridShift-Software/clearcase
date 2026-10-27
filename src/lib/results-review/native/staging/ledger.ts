import { contractError } from '../../../server/runtime/errors.ts';
import type { NativeD1, NativeD1Statement } from '../ports.ts';
import type { CleanupRow, StagedRow, StagingLedger, StagingSession } from './ports.ts';

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const integrity = (): never => { throw contractError('integrity', false); };

type StagedRowRaw = { path: string; sha256: string; size: number; pdf: number };
const rowOf = (r: StagedRowRaw): StagedRow => ({ path: r.path, sha256: r.sha256, size: r.size, pdf: r.pdf === 1 });
type CleanupRaw = { reason: 'complete' | 'abandoned'; after_key: string; swept: number; state: 'sweeping' | 'done' };
const cleanupOf = (r: CleanupRaw): CleanupRow => ({ reason: r.reason, afterKey: r.after_key, swept: r.swept, state: r.state });
const CLEANUP = 'SELECT reason, after_key, swept, state FROM native_import_cleanup WHERE client_id = ? AND case_id = ? AND operation_id = ?';
type SessionRow = { operation_id: string; submission_revision_id: string; manifest_sha256: string; manifest_size: number; results_version: string; expected_files: number; expected_bytes: number; request_sha256: string; operator_issuer: string; operator_subject: string; opened_at: string };
const SESSION = 'operation_id, submission_revision_id, manifest_sha256, manifest_size, results_version, expected_files, expected_bytes, request_sha256, operator_issuer, operator_subject, opened_at';
const sessionOf = (r: SessionRow): StagingSession => ({ operationId: r.operation_id, submissionRevisionId: r.submission_revision_id, manifestSha256: r.manifest_sha256, manifestSize: r.manifest_size, resultsVersion: r.results_version,
  expectedFiles: r.expected_files, expectedBytes: r.expected_bytes, requestSha256: r.request_sha256, operator: { issuer: r.operator_issuer, subject: r.operator_subject }, openedAt: r.opened_at });

/** The row of table alias `t` belongs to the session `s`. */
const of = (t: string) => `${t}.client_id = s.client_id AND ${t}.case_id = s.case_id AND ${t}.operation_id = s.operation_id`;
/** The session `s` has a candidate: the import finished. */
const FINISHED = `EXISTS (SELECT 1 FROM native_candidate k WHERE ${of('k')})`;
/** The session `s` was opened before the cutoff and nothing has been accepted or staged under it since. Three bound cutoffs. */
const IDLE = `s.opened_at < ? AND NOT EXISTS (SELECT 1 FROM native_import_staged_file f WHERE ${of('f')} AND f.accepted_at >= ?)
  AND NOT EXISTS (SELECT 1 FROM native_import_stage_run r WHERE ${of('r')} AND r.updated_at >= ?)`;
/** A durable writer start has no matching settlement. Facts are immutable and retained, including across restarts. */
const WRITING = `EXISTS (SELECT 1 FROM native_import_stage_fact w WHERE ${of('w')} AND w.epoch = 0 AND w.pass = 'writer-start'
  AND NOT EXISTS (SELECT 1 FROM native_import_stage_fact e WHERE e.client_id = w.client_id AND e.case_id = w.case_id AND e.operation_id = w.operation_id
    AND e.epoch = 0 AND e.pass = 'writer-end' AND e.key = w.key))`;
/** Bytes held by the client's sessions whose sweep is not done: one bound client id. */
const HELD = `(SELECT COALESCE(SUM(h.expected_bytes + h.manifest_size), 0) FROM native_import_session h WHERE h.client_id = ?
  AND NOT EXISTS (SELECT 1 FROM native_import_cleanup c WHERE c.client_id = h.client_id AND c.case_id = h.case_id AND c.operation_id = h.operation_id AND c.state = 'done'))`;

/** The D1 adapter over migration `0002_native_import_staging.sql`. `rowsPerBatch` is the storage budget's `maxRowsPerBatch`. */
export function d1StagingLedger(db: NativeD1, o: { rowsPerBatch: number }): StagingLedger {
  if (!Number.isSafeInteger(o.rowsPerBatch) || o.rowsPerBatch < 1) throw contractError('storage-unavailable', true);
  const get = (a: { clientId: string; caseId: string; operationId: string }) =>
    db.prepare(`SELECT ${SESSION} FROM native_import_session WHERE client_id = ? AND case_id = ? AND operation_id = ?`).bind(a.clientId, a.caseId, a.operationId).first<SessionRow>().catch(unavailable);
  const rowsOf = async (a: { clientId: string; caseId: string; operationId: string }, paths: readonly string[]) => {
    const marks = paths.map(() => '?').join(', ');
    const { results } = await db.prepare(`SELECT path, sha256, size, pdf FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? AND path IN (${marks}) ORDER BY path`)
      .bind(a.clientId, a.caseId, a.operationId, ...paths).all<StagedRowRaw>().catch(unavailable);
    return results.map(rowOf);
  };

  const ledger: StagingLedger = {
    async open(a) {
      const sameRequest = (p: StagingSession) => p.operator.issuer === a.operator.issuer && p.operator.subject === a.operator.subject && p.requestSha256 === a.requestSha256 && p.submissionRevisionId === a.submissionRevisionId && p.manifestSha256 === a.manifestSha256;
      // INSERT ... WHERE NOT EXISTS: a prior or concurrent session of the same operation inserts nothing, nor does one whose guard fails.
      const { results } = await db.prepare(`INSERT INTO native_import_session (client_id, case_id, operation_id, submission_revision_id, manifest_sha256, manifest_size, results_version, expected_files, expected_bytes, request_sha256, operator_issuer, operator_subject, opened_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM native_import_session WHERE client_id = ? AND case_id = ? AND operation_id = ?)
          AND ${HELD} + ? <= ?${a.guard ? ` AND ${a.guard.sql}` : ''}
        RETURNING ${SESSION}`)
        .bind(a.clientId, a.caseId, a.operationId, a.submissionRevisionId, a.manifestSha256, a.manifestSize, a.resultsVersion, a.expectedFiles, a.expectedBytes, a.requestSha256, a.operator.issuer, a.operator.subject, a.at,
          a.clientId, a.caseId, a.operationId, a.clientId, a.expectedBytes + a.manifestSize, a.maxStagedBytes, ...(a.guard?.values ?? [])).all<SessionRow>().catch(unavailable);
      if (results.length === 1) { const s = sessionOf(results[0]!); return sameRequest(s) ? { kind: 'opened', session: s } : { kind: 'operation-reused' }; }
      const prior = await get(a);
      if (!prior) {
        // Nothing was written: the cap, or else the guard, refused it.
        const held = await ledger.held(a);
        return held + a.expectedBytes + a.manifestSize > a.maxStagedBytes ? { kind: 'over-quota', held } : unavailable();
      }
      const s = sessionOf(prior);
      return sameRequest(s) ? { kind: 'repeated', session: s } : { kind: 'operation-reused' };
    },

    async session(a) { const r = await get(a); return r ? sessionOf(r) : null; },

    async accepted(a) {
      if (a.paths) return a.paths.length === 0 ? [] : rowsOf(a, a.paths);
      const { results } = await db.prepare('SELECT path, sha256, size, pdf FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? ORDER BY path LIMIT ?')
        .bind(a.clientId, a.caseId, a.operationId, a.limit ?? 10_000).all<StagedRowRaw>().catch(unavailable);
      return results.map(rowOf);
    },

    async accept(a) {
      for (let i = 0; i < a.rows.length; i += o.rowsPerBatch) {
        const chunk = a.rows.slice(i, i + o.rowsPerBatch);
        const statements: NativeD1Statement[] = chunk.map((r) => db.prepare(`INSERT INTO native_import_staged_file (client_id, case_id, operation_id, path, sha256, size, accepted_at, pdf)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM native_import_session WHERE client_id = ? AND case_id = ? AND operation_id = ?)
            AND NOT EXISTS (SELECT 1 FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? AND path = ?)
            AND NOT EXISTS (SELECT 1 FROM native_import_cleanup WHERE client_id = ? AND case_id = ? AND operation_id = ?)${a.guard ? ` AND ${a.guard.sql}` : ''}`)
          .bind(a.clientId, a.caseId, a.operationId, r.path, r.sha256, r.size, a.at, r.pdf ? 1 : 0, a.clientId, a.caseId, a.operationId, a.clientId, a.caseId, a.operationId, r.path,
            a.clientId, a.caseId, a.operationId, ...(a.guard?.values ?? [])));
        await db.batch(statements).catch(unavailable);
      }
      // Read back what was asked for: a row that is missing means a sweep began first, or the guard or the session did not hold; a different one is corruption.
      for (let i = 0; i < a.rows.length; i += 32) {
        const want = a.rows.slice(i, i + 32);
        const have = new Map((await rowsOf(a, want.map((r) => r.path))).map((r) => [r.path, r]));
        for (const r of want) {
          const h = have.get(r.path);
          if (!h) return (await ledger.cleanup(a)) ? 'swept' : unavailable();
          if (h.sha256 !== r.sha256 || h.size !== r.size || h.pdf !== r.pdf) return integrity();
        }
      }
      return 'accepted';
    },

    async totals(a) {
      const r = await db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ?')
        .bind(a.clientId, a.caseId, a.operationId).first<{ files: number; bytes: number }>().catch(unavailable);
      return r ?? unavailable();
    },

    async beginWrite(a) {
      const writerId = crypto.randomUUID();
      const { results } = await db.prepare(`INSERT INTO native_import_stage_fact (client_id, case_id, operation_id, epoch, pass, key, value)
        SELECT s.client_id, s.case_id, s.operation_id, 0, 'writer-start', ?, '{}' FROM native_import_session s
        WHERE s.client_id = ? AND s.case_id = ? AND s.operation_id = ?
          AND NOT EXISTS (SELECT 1 FROM native_import_cleanup c WHERE ${of('c')})${a.guard ? ` AND ${a.guard.sql}` : ''} RETURNING key`)
        .bind(writerId, a.clientId, a.caseId, a.operationId, ...(a.guard?.values ?? [])).all<{ key: string }>().catch(unavailable);
      return results.length === 1 ? writerId : null;
    },

    async endWrite(a) {
      await db.prepare(`INSERT INTO native_import_stage_fact (client_id, case_id, operation_id, epoch, pass, key, value)
        SELECT w.client_id, w.case_id, w.operation_id, 0, 'writer-end', w.key, '{}' FROM native_import_stage_fact w
        WHERE w.client_id = ? AND w.case_id = ? AND w.operation_id = ? AND w.epoch = 0 AND w.pass = 'writer-start' AND w.key = ?
          AND NOT EXISTS (SELECT 1 FROM native_import_stage_fact e WHERE e.client_id = w.client_id AND e.case_id = w.case_id AND e.operation_id = w.operation_id AND e.epoch = 0 AND e.pass = 'writer-end' AND e.key = w.key)`)
        .bind(a.clientId, a.caseId, a.operationId, a.writerId).run().catch(unavailable);
    },

    async writing(a) {
      const r = await db.prepare(`SELECT 1 AS active FROM native_import_session s WHERE s.client_id = ? AND s.case_id = ? AND s.operation_id = ? AND ${WRITING}`)
        .bind(a.clientId, a.caseId, a.operationId).first<{ active: number }>().catch(unavailable);
      return r !== null;
    },

    async cleanup(a) {
      const r = await db.prepare(CLEANUP).bind(a.clientId, a.caseId, a.operationId).first<CleanupRaw>().catch(unavailable);
      return r ? cleanupOf(r) : null;
    },

    async startCleanup(a) {
      // INSERT ... SELECT: only while the operation is due, and once; a repeated or racing start inserts nothing and reads back what exists.
      // From here on no file is accepted under the operation (accept holds NOT EXISTS on this row).
      const due = a.reason === 'complete' ? FINISHED : IDLE;
      await db.prepare(`INSERT INTO native_import_cleanup (client_id, case_id, operation_id, reason, after_key, swept, state, started_at, finished_at)
        SELECT s.client_id, s.case_id, s.operation_id, ?, '', 0, 'sweeping', ?, NULL FROM native_import_session s WHERE s.client_id = ? AND s.case_id = ? AND s.operation_id = ?
          AND NOT EXISTS (SELECT 1 FROM native_import_cleanup c WHERE ${of('c')}) AND ${due}${a.guard ? ` AND ${a.guard.sql}` : ''}`)
        .bind(a.reason, a.at, a.clientId, a.caseId, a.operationId, ...(a.reason === 'complete' ? [] : [a.idleFrom, a.idleFrom, a.idleFrom]), ...(a.guard?.values ?? [])).run().catch(unavailable);
      return ledger.cleanup(a);
    },

    async idle(a) {
      const r = await db.prepare(`SELECT 1 AS idle FROM native_import_session s WHERE s.client_id = ? AND s.case_id = ? AND s.operation_id = ? AND ${IDLE}`)
        .bind(a.clientId, a.caseId, a.operationId, a.idleFrom, a.idleFrom, a.idleFrom).first<{ idle: number }>().catch(unavailable);
      return r !== null;
    },

    async advanceCleanup(a) {
      // Only from the position the step read: a step that ran beside another and lost leaves the other's move, which covers its own deletes.
      await db.prepare(`UPDATE native_import_cleanup SET after_key = ?, swept = ?, state = ?, finished_at = ? WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state = 'sweeping' AND after_key = ?
        AND NOT EXISTS (SELECT 1 FROM native_import_session s WHERE s.client_id = native_import_cleanup.client_id AND s.case_id = native_import_cleanup.case_id AND s.operation_id = native_import_cleanup.operation_id AND ${WRITING})${a.guard ? ` AND ${a.guard.sql}` : ''}`)
        .bind(a.afterKey, a.swept, a.done ? 'done' : 'sweeping', a.done ? a.at : null, a.clientId, a.caseId, a.operationId, a.from, ...(a.guard?.values ?? [])).run().catch(unavailable);
      const r = await db.prepare(CLEANUP).bind(a.clientId, a.caseId, a.operationId).first<CleanupRaw>().catch(unavailable);
      if (!r) integrity();
      // Still where the step read it although it asked to move: the guard did not hold.
      if (r!.state === 'sweeping' && r!.after_key === a.from && (a.afterKey !== a.from || a.done)) unavailable();
    },

    async nextDue(a) {
      const r = await db.prepare(`SELECT s.operation_id AS operation_id FROM native_import_session s
          LEFT JOIN native_import_cleanup c ON ${of('c')}
          WHERE s.client_id = ? AND s.case_id = ? AND NOT ${WRITING} AND (c.state = 'sweeping' OR (c.state IS NULL AND (${FINISHED} OR (${IDLE}))))
          ORDER BY (c.state = 'sweeping') DESC, ${FINISHED} DESC, s.opened_at, s.operation_id LIMIT 1`)
        .bind(a.clientId, a.caseId, a.idleFrom, a.idleFrom, a.idleFrom).first<{ operation_id: string }>().catch(unavailable);
      return r ? { operationId: r.operation_id } : null;
    },

    async held(a) {
      const r = await db.prepare(`SELECT ${HELD} AS n`).bind(a.clientId).first<{ n: number }>().catch(unavailable);
      return r?.n ?? unavailable();
    },
  };
  return ledger;
}
