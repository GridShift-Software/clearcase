import { contractError } from '../../../server/runtime/errors.ts';
import type { NativeD1, NativeD1Statement } from '../ports.ts';
import type { CleanupRow, StagedRow, StagingLedger, StagingSession } from './ports.ts';

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const integrity = (): never => { throw contractError('integrity', false); };

type StagedRowRaw = { path: string; sha256: string; size: number; pdf: number };
const rowOf = (r: StagedRowRaw): StagedRow => ({ path: r.path, sha256: r.sha256, size: r.size, pdf: r.pdf === 1 });
type CleanupRaw = { reason: 'complete' | 'abandoned'; after_path: string; swept: number; state: 'sweeping' | 'done' };
const cleanupOf = (r: CleanupRaw): CleanupRow => ({ reason: r.reason, afterPath: r.after_path, swept: r.swept, state: r.state });
type SessionRow = { operation_id: string; submission_revision_id: string; manifest_sha256: string; manifest_size: number; results_version: string; expected_files: number; expected_bytes: number; request_sha256: string; operator_issuer: string; operator_subject: string; opened_at: string };
const SESSION = 'operation_id, submission_revision_id, manifest_sha256, manifest_size, results_version, expected_files, expected_bytes, request_sha256, operator_issuer, operator_subject, opened_at';
const sessionOf = (r: SessionRow): StagingSession => ({ operationId: r.operation_id, submissionRevisionId: r.submission_revision_id, manifestSha256: r.manifest_sha256, manifestSize: r.manifest_size, resultsVersion: r.results_version,
  expectedFiles: r.expected_files, expectedBytes: r.expected_bytes, requestSha256: r.request_sha256, operator: { issuer: r.operator_issuer, subject: r.operator_subject }, openedAt: r.opened_at });

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

  return {
    async open(a) {
      const same = (p: StagingSession) => p.operator.issuer === a.operator.issuer && p.operator.subject === a.operator.subject && p.requestSha256 === a.requestSha256 && p.submissionRevisionId === a.submissionRevisionId && p.manifestSha256 === a.manifestSha256;
      // INSERT ... WHERE NOT EXISTS: a prior or concurrent session of the same operation inserts nothing, nor does one whose guard fails.
      const { results } = await db.prepare(`INSERT INTO native_import_session (client_id, case_id, operation_id, submission_revision_id, manifest_sha256, manifest_size, results_version, expected_files, expected_bytes, request_sha256, operator_issuer, operator_subject, opened_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM native_import_session WHERE client_id = ? AND case_id = ? AND operation_id = ?)${a.guard ? ` AND ${a.guard.sql}` : ''}
        RETURNING ${SESSION}`)
        .bind(a.clientId, a.caseId, a.operationId, a.submissionRevisionId, a.manifestSha256, a.manifestSize, a.resultsVersion, a.expectedFiles, a.expectedBytes, a.requestSha256, a.operator.issuer, a.operator.subject, a.at,
          a.clientId, a.caseId, a.operationId, ...(a.guard?.values ?? [])).all<SessionRow>().catch(unavailable);
      if (results.length === 1) { const s = sessionOf(results[0]!); return same(s) ? { kind: 'opened', session: s } : { kind: 'operation-reused' }; }
      const prior = await get(a);
      if (!prior) return unavailable();
      const s = sessionOf(prior);
      return same(s) ? { kind: 'repeated', session: s } : { kind: 'operation-reused' };
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
            AND NOT EXISTS (SELECT 1 FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? AND path = ?)${a.guard ? ` AND ${a.guard.sql}` : ''}`)
          .bind(a.clientId, a.caseId, a.operationId, r.path, r.sha256, r.size, a.at, r.pdf ? 1 : 0, a.clientId, a.caseId, a.operationId, a.clientId, a.caseId, a.operationId, r.path, ...(a.guard?.values ?? [])));
        await db.batch(statements).catch(unavailable);
      }
      // Read back what was asked for: a row that is missing means the guard or the session did not hold; a different one is corruption.
      for (let i = 0; i < a.rows.length; i += 32) {
        const want = a.rows.slice(i, i + 32);
        const have = new Map((await rowsOf(a, want.map((r) => r.path))).map((r) => [r.path, r]));
        for (const r of want) {
          const h = have.get(r.path);
          if (!h) return unavailable();
          if (h.sha256 !== r.sha256 || h.size !== r.size || h.pdf !== r.pdf) return integrity();
        }
      }
    },

    async totals(a) {
      const r = await db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ?')
        .bind(a.clientId, a.caseId, a.operationId).first<{ files: number; bytes: number }>().catch(unavailable);
      return r ?? unavailable();
    },

    async cleanup(a) {
      const r = await db.prepare('SELECT reason, after_path, swept, state FROM native_import_cleanup WHERE client_id = ? AND case_id = ? AND operation_id = ?').bind(a.clientId, a.caseId, a.operationId).first<CleanupRaw>().catch(unavailable);
      return r ? cleanupOf(r) : null;
    },

    async startCleanup(a) {
      // INSERT ... WHERE NOT EXISTS: a repeated or racing start inserts nothing and reads back the record that exists.
      await db.prepare(`INSERT INTO native_import_cleanup (client_id, case_id, operation_id, reason, after_path, swept, state, started_at, finished_at)
        SELECT ?, ?, ?, ?, '', 0, 'sweeping', ?, NULL WHERE EXISTS (SELECT 1 FROM native_import_session WHERE client_id = ? AND case_id = ? AND operation_id = ?)
          AND NOT EXISTS (SELECT 1 FROM native_import_cleanup WHERE client_id = ? AND case_id = ? AND operation_id = ?)${a.guard ? ` AND ${a.guard.sql}` : ''}`)
        .bind(a.clientId, a.caseId, a.operationId, a.reason, a.at, a.clientId, a.caseId, a.operationId, a.clientId, a.caseId, a.operationId, ...(a.guard?.values ?? [])).run().catch(unavailable);
      const r = await db.prepare('SELECT reason, after_path, swept, state FROM native_import_cleanup WHERE client_id = ? AND case_id = ? AND operation_id = ?').bind(a.clientId, a.caseId, a.operationId).first<CleanupRaw>().catch(unavailable);
      return r ? cleanupOf(r) : unavailable();
    },

    async after(a) {
      const { results } = await db.prepare('SELECT path, sha256, size, pdf FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? AND path > ? ORDER BY path LIMIT ?')
        .bind(a.clientId, a.caseId, a.operationId, a.afterPath, a.limit).all<StagedRowRaw>().catch(unavailable);
      return results.map(rowOf);
    },

    async remainingAfter(a) {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? AND path > ?').bind(a.clientId, a.caseId, a.operationId, a.afterPath).first<{ n: number }>().catch(unavailable);
      return r?.n ?? unavailable();
    },

    async neededElsewhere(a) {
      const needed = new Set<string>();
      // D1 binds at most 100 parameters to a statement: ten are the case, the operation and the cutoffs, the rest are digests.
      for (let i = 0; i < a.sha256s.length; i += 40) {
        const chunk = a.sha256s.slice(i, i + 40);
        const marks = chunk.map(() => '?').join(', ');
        // Live: not swept, no candidate, and either opened recently or running recently. Its files, and its manifest, are what it still needs.
        const live = `NOT EXISTS (SELECT 1 FROM native_import_cleanup c WHERE c.client_id = s.client_id AND c.case_id = s.case_id AND c.operation_id = s.operation_id)
          AND NOT EXISTS (SELECT 1 FROM native_candidate k WHERE k.client_id = s.client_id AND k.case_id = s.case_id AND k.operation_id = s.operation_id)
          AND (s.opened_at >= ? OR EXISTS (SELECT 1 FROM native_import_stage_run r WHERE r.client_id = s.client_id AND r.case_id = s.case_id AND r.operation_id = s.operation_id AND r.phase <> 'done' AND r.updated_at >= ?))`;
        const { results } = await db.prepare(`SELECT DISTINCT sha256 FROM (
            SELECT f.sha256 AS sha256 FROM native_import_staged_file f JOIN native_import_session s ON s.client_id = f.client_id AND s.case_id = f.case_id AND s.operation_id = f.operation_id
              WHERE f.client_id = ? AND f.case_id = ? AND f.operation_id <> ? AND ${live}
            UNION ALL
            SELECT s.manifest_sha256 FROM native_import_session s WHERE s.client_id = ? AND s.case_id = ? AND s.operation_id <> ? AND ${live}
          ) WHERE sha256 IN (${marks})`)
          .bind(a.clientId, a.caseId, a.operationId, a.liveFrom, a.liveFrom, a.clientId, a.caseId, a.operationId, a.liveFrom, a.liveFrom, ...chunk).all<{ sha256: string }>().catch(unavailable);
        for (const r of results) needed.add(r.sha256);
      }
      return needed;
    },

    async advanceCleanup(a) {
      await db.prepare(`UPDATE native_import_cleanup SET after_path = ?, swept = ?, state = ?, finished_at = ? WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state = 'sweeping'${a.guard ? ` AND ${a.guard.sql}` : ''}`)
        .bind(a.afterPath, a.swept, a.done ? 'done' : 'sweeping', a.done ? a.at : null, a.clientId, a.caseId, a.operationId, ...(a.guard?.values ?? [])).run().catch(unavailable);
      const r = await db.prepare('SELECT after_path, swept, state FROM native_import_cleanup WHERE client_id = ? AND case_id = ? AND operation_id = ?').bind(a.clientId, a.caseId, a.operationId).first<CleanupRaw>().catch(unavailable);
      if (!r || r.after_path !== a.afterPath || r.swept !== a.swept || r.state !== (a.done ? 'done' : 'sweeping')) integrity();
    },

    async nextExpired(a) {
      const r = await db.prepare(`SELECT s.operation_id AS operation_id FROM native_import_session s
          LEFT JOIN native_import_cleanup c ON c.client_id = s.client_id AND c.case_id = s.case_id AND c.operation_id = s.operation_id
          WHERE s.client_id = ? AND s.case_id = ? AND (c.state = 'sweeping' OR (c.state IS NULL AND s.opened_at < ?
            AND NOT EXISTS (SELECT 1 FROM native_import_stage_run r WHERE r.client_id = s.client_id AND r.case_id = s.case_id AND r.operation_id = s.operation_id AND r.phase <> 'done' AND r.updated_at >= ?)))
          ORDER BY (c.state = 'sweeping') DESC, s.opened_at, s.operation_id LIMIT 1`)
        .bind(a.clientId, a.caseId, a.before, a.before).first<{ operation_id: string }>().catch(unavailable);
      return r ? { operationId: r.operation_id } : null;
    },
  };
}