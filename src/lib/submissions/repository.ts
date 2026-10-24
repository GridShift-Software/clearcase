import type { CaseId, ClientId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import type { Scoped, SubmissionManifest, SubmissionRepository, UploadRecord, UploadState } from './ports.ts';

/** The part of a Cloudflare D1 binding the intake uses. The parent passes the client's per-deployment `DB`. */
export type IntakeD1Value = string | number | null;
export interface IntakeD1Statement {
  bind(...values: IntakeD1Value[]): IntakeD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface IntakeD1 { prepare(sql: string): IntakeD1Statement; batch(statements: IntakeD1Statement[]): Promise<unknown[]> }

type UploadRow = { operation_id: string; asset_id: string; path: string; filename: string; media_type: string; size: number; sha256: string; state: UploadState };
type RevisionRow = { revision_id: string; sequence: number; operation_id: string; finalized_at: string };
type FileRow = { path: string; filename: string; media_type: string; size: number; sha256: string; asset_id: string };

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const UPLOAD = 'SELECT operation_id, asset_id, path, filename, media_type, size, sha256, state FROM submissions_upload';
/** The revision id of an operation's finalized submission: derived, so a retry can only ever name the same revision. */
export const revisionIdOf = (operationId: string) => `subrev-${operationId}`;

function record(s: Scoped, r: UploadRow): UploadRecord {
  return { clientId: s.clientId, caseId: s.caseId, operationId: r.operation_id, assetId: r.asset_id, path: r.path, filename: r.filename, mediaType: 'application/pdf', size: r.size, sha256: r.sha256, state: r.state };
}

/** The D1 adapter of `SubmissionRepository` over migration `0001_submissions_intake.sql`. */
export function d1SubmissionRepository(db: IntakeD1): SubmissionRepository {
  const upload = (s: Scoped, operationId: string) =>
    db.prepare(`${UPLOAD} WHERE client_id = ? AND case_id = ? AND operation_id = ?`).bind(s.clientId, s.caseId, operationId).first<UploadRow>().catch(unavailable);
  async function manifest(s: Scoped, rev: RevisionRow): Promise<SubmissionManifest> {
    const files = await db.prepare('SELECT path, filename, media_type, size, sha256, asset_id FROM submissions_file WHERE client_id = ? AND case_id = ? AND revision_id = ? ORDER BY path_key')
      .bind(s.clientId, s.caseId, rev.revision_id).all<FileRow>().catch(unavailable);
    // A revision without its file is not a recorded submission; the batch below writes both or neither.
    if (files.results.length === 0) unavailable();
    return Object.freeze({
      format: 'clearcase.submission-manifest/1' as const, clientId: s.clientId as ClientId, caseId: s.caseId as CaseId,
      revisionId: rev.revision_id, sequence: rev.sequence, operationId: rev.operation_id, finalizedAt: rev.finalized_at,
      files: Object.freeze(files.results.map((f) => Object.freeze({ path: f.path, filename: f.filename, mediaType: f.media_type, size: f.size, sha256: f.sha256, assetId: f.asset_id }))),
    });
  }
  async function revision(s: Scoped, operationId: string) {
    const rev = await db.prepare('SELECT revision_id, sequence, operation_id, finalized_at FROM submissions_revision WHERE client_id = ? AND case_id = ? AND operation_id = ?')
      .bind(s.clientId, s.caseId, operationId).first<RevisionRow>().catch(unavailable);
    return rev ? manifest(s, rev) : null;
  }
  const same = (r: UploadRow, a: Parameters<SubmissionRepository['declare']>[0]) =>
    r.asset_id === a.assetId && r.path === a.path && r.filename === a.filename && r.media_type === a.mediaType && r.size === a.size && r.sha256 === a.sha256;

  const reserveRevision: SubmissionRepository['reserveRevision'] = async (a) => {
    const existing = await revision(a, a.operationId);
    if (existing) return existing;
    const r = await upload(a, a.operationId);
    if (!r || r.state === 'received') return unavailable();
    const id = revisionIdOf(a.operationId);
    try {
      await db.batch([
        // the revision takes the case's next sequence; the migration's triggers refuse a colliding sequence, operation or
        // revision id, so a concurrent reservation that took the same sequence rolls the whole batch back and the
        // caller's retry takes the next one
        db.prepare(`INSERT INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at)
          SELECT ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM submissions_revision WHERE client_id = ? AND case_id = ?), ?, 1, ?
          WHERE EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state IN ('stored', 'reserved', 'finalized'))`)
          .bind(a.clientId, a.caseId, id, a.clientId, a.caseId, a.operationId, a.at, a.clientId, a.caseId, a.operationId),
        db.prepare(`INSERT INTO submissions_file (client_id, case_id, revision_id, path, path_key, filename, media_type, size, sha256, asset_id)
          SELECT client_id, case_id, ?, path, ?, filename, media_type, size, sha256, asset_id FROM submissions_upload WHERE client_id = ? AND case_id = ? AND operation_id = ?`)
          .bind(id, r.path.normalize('NFKC').toLowerCase(), a.clientId, a.caseId, a.operationId),
        db.prepare("UPDATE submissions_upload SET state = 'reserved' WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state = 'stored'")
          .bind(a.clientId, a.caseId, a.operationId),
      ]);
    } catch {
      // The outcome is unknown from here (a lost answer can follow a commit): read again; only a recorded revision is success.
      const now = await revision(a, a.operationId);
      if (now) return now;
      return unavailable();
    }
    return (await revision(a, a.operationId)) ?? unavailable();
  };

  return {
    async declare(a) {
      const prior = await upload(a, a.operationId);
      if (prior) return same(prior, a) ? { kind: 'declared', repeated: true } : { kind: 'operation-reused' };
      // INSERT ... SELECT ... WHERE NOT EXISTS: a concurrent declaration of the same operation inserts nothing here (the
      // migration's BEFORE INSERT trigger would refuse a colliding insert, even one with ON CONFLICT); a different operation
      // that collides on the asset key is refused by that trigger and answers as unavailable, never by overwriting a row.
      await db.prepare(`INSERT INTO submissions_upload (client_id, case_id, operation_id, asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = ? AND case_id = ? AND operation_id = ?)`)
        .bind(a.clientId, a.caseId, a.operationId, a.assetId, a.path, a.filename, a.mediaType, a.size, a.sha256, a.principal.issuer, a.principal.subject, a.at, a.clientId, a.caseId, a.operationId).run().catch(unavailable);
      // Read back: a concurrent declaration of the same operation wins or matches; never two answers for one id.
      const row = await upload(a, a.operationId);
      if (!row) return unavailable();
      return same(row, a) ? { kind: 'declared', repeated: false } : { kind: 'operation-reused' };
    },
    async upload(a) {
      const r = await upload(a, a.operationId);
      return r ? record(a, r) : null;
    },
    async markStored(a) {
      await db.prepare("UPDATE submissions_upload SET state = 'stored', stored_at = ? WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state = 'received'")
        .bind(a.at, a.clientId, a.caseId, a.operationId).run().catch(unavailable);
      const r = await upload(a, a.operationId);
      if (!r || r.state === 'received') unavailable();
    },
    reserveRevision,
    async commitRevision(a) {
      // Precommit if it is not recorded yet (idempotent), then mark the revision final. The mark moves only 'reserved' forward,
      // and only the stored revision is ever returned.
      const manifest = await reserveRevision(a);
      const r = await upload(a, a.operationId);
      if (!r) return unavailable();
      if (r.state !== 'finalized') {
        await db.prepare("UPDATE submissions_upload SET state = 'finalized' WHERE client_id = ? AND case_id = ? AND operation_id = ? AND state IN ('stored', 'reserved')")
          .bind(a.clientId, a.caseId, a.operationId).run().catch(unavailable);
        const now = await upload(a, a.operationId);
        if (!now || now.state !== 'finalized') return unavailable();
      }
      return manifest;
    },
    revision: (a) => revision(a, a.operationId),
    async list(a) {
      const rows = await db.prepare(`${UPLOAD} WHERE client_id = ? AND case_id = ? ORDER BY declared_at, operation_id`).bind(a.clientId, a.caseId).all<UploadRow>().catch(unavailable);
      const out = [];
      for (const r of rows.results) out.push({ upload: record(a, r), manifest: r.state === 'finalized' ? await revision(a, r.operation_id) : null });
      return out;
    },
  };
}
