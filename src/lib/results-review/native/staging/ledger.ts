import { contractError } from '../../../server/runtime/errors.ts';
import type { NativeD1, NativeD1Statement } from '../ports.ts';
import type { StagedRow, StagingLedger, StagingSession } from './ports.ts';

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const integrity = (): never => { throw contractError('integrity', false); };

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
    const { results } = await db.prepare(`SELECT path, sha256, size FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? AND path IN (${marks}) ORDER BY path`)
      .bind(a.clientId, a.caseId, a.operationId, ...paths).all<StagedRow>().catch(unavailable);
    return results;
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
      const { results } = await db.prepare('SELECT path, sha256, size FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ? ORDER BY path LIMIT ?')
        .bind(a.clientId, a.caseId, a.operationId, a.limit ?? 10_000).all<StagedRow>().catch(unavailable);
      return results;
    },

    async accept(a) {
      for (let i = 0; i < a.rows.length; i += o.rowsPerBatch) {
        const chunk = a.rows.slice(i, i + o.rowsPerBatch);
        const statements: NativeD1Statement[] = chunk.map((r) => db.prepare(`INSERT OR IGNORE INTO native_import_staged_file (client_id, case_id, operation_id, path, sha256, size, accepted_at)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM native_import_session WHERE client_id = ? AND case_id = ? AND operation_id = ?)${a.guard ? ` AND ${a.guard.sql}` : ''}`)
          .bind(a.clientId, a.caseId, a.operationId, r.path, r.sha256, r.size, a.at, a.clientId, a.caseId, a.operationId, ...(a.guard?.values ?? [])));
        await db.batch(statements).catch(unavailable);
      }
      // Read back what was asked for: a row that is missing means the guard or the session did not hold; a different one is corruption.
      for (let i = 0; i < a.rows.length; i += 32) {
        const want = a.rows.slice(i, i + 32);
        const have = new Map((await rowsOf(a, want.map((r) => r.path))).map((r) => [r.path, r]));
        for (const r of want) {
          const h = have.get(r.path);
          if (!h) return unavailable();
          if (h.sha256 !== r.sha256 || h.size !== r.size) return integrity();
        }
      }
    },

    async totals(a) {
      const r = await db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM native_import_staged_file WHERE client_id = ? AND case_id = ? AND operation_id = ?')
        .bind(a.clientId, a.caseId, a.operationId).first<{ files: number; bytes: number }>().catch(unavailable);
      return r ?? unavailable();
    },
  };
}
