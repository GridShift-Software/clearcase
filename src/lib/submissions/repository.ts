import type { CaseId, ClientId } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import type { Scoped, SetRecord, SetState, SubmissionManifest, SubmissionRepository, UploadRecord, UploadState } from './ports.ts';

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
type SetRow = { set_id: string; file_count: number; total_bytes: number; state: SetState; files_sha256: string | null; opened_at: string; sealed_at: string | null; declared: number; stored: number; finalized: number; sequence: number | null };

const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const UPLOAD = 'SELECT operation_id, asset_id, path, filename, media_type, size, sha256, state FROM submissions_upload';
// A set with its counts and, once the seal recorded it, its revision's sequence: one statement per read.
const SET = `SELECT s.set_id, s.file_count, s.total_bytes, s.state, s.files_sha256, s.opened_at, s.sealed_at,
    (SELECT COUNT(*) FROM submissions_set_member m WHERE m.client_id = s.client_id AND m.case_id = s.case_id AND m.set_id = s.set_id) AS declared,
    (SELECT COUNT(*) FROM submissions_set_member m JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
      WHERE m.client_id = s.client_id AND m.case_id = s.case_id AND m.set_id = s.set_id AND u.state <> 'received') AS stored,
    (SELECT COUNT(*) FROM submissions_set_member m JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
      WHERE m.client_id = s.client_id AND m.case_id = s.case_id AND m.set_id = s.set_id AND u.state = 'finalized') AS finalized,
    (SELECT r.sequence FROM submissions_revision r WHERE r.client_id = s.client_id AND r.case_id = s.case_id AND r.operation_id = s.set_id) AS sequence
  FROM submissions_set s`;
const MEMBER = 'EXISTS (SELECT 1 FROM submissions_set_member m WHERE m.client_id = u.client_id AND m.case_id = u.case_id AND m.operation_id = u.operation_id)';
/** The revision id of an operation's finalized submission: derived, so a retry can only ever name the same revision. */
export const revisionIdOf = (operationId: string) => `subrev-${operationId}`;

function record(s: Scoped, r: UploadRow): UploadRecord {
  return { clientId: s.clientId, caseId: s.caseId, operationId: r.operation_id, assetId: r.asset_id, path: r.path, filename: r.filename, mediaType: 'application/pdf', size: r.size, sha256: r.sha256, state: r.state };
}
function setRecord(s: Scoped, r: SetRow): SetRecord {
  return {
    clientId: s.clientId, caseId: s.caseId, setId: r.set_id, fileCount: r.file_count, totalBytes: r.total_bytes, state: r.state, filesSha256: r.files_sha256,
    openedAt: r.opened_at, sealedAt: r.sealed_at, declared: r.declared, stored: r.stored, finalized: r.finalized, sequence: r.sequence,
  };
}

/** The D1 adapter of `SubmissionRepository` over migrations `0001_submissions_intake.sql` and `0002_submissions_file_sets.sql`. */
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
  const set = (s: Scoped, setId: string) =>
    db.prepare(`${SET} WHERE s.client_id = ? AND s.case_id = ? AND s.set_id = ?`).bind(s.clientId, s.caseId, setId).first<SetRow>().catch(unavailable)
      .then((r) => (r ? setRecord(s, r) : null));
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
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = ? AND case_id = ? AND operation_id = ?)
          AND NOT EXISTS (SELECT 1 FROM submissions_set WHERE client_id = ? AND case_id = ? AND set_id = ?)`)
        .bind(a.clientId, a.caseId, a.operationId, a.assetId, a.path, a.filename, a.mediaType, a.size, a.sha256, a.principal.issuer, a.principal.subject, a.at, a.clientId, a.caseId, a.operationId, a.clientId, a.caseId, a.operationId).run().catch(unavailable);
      // Read back: a concurrent declaration of the same operation wins or matches; never two answers for one id.
      const row = await upload(a, a.operationId);
      if (!row) return (await set(a, a.operationId)) ? { kind: 'operation-reused' } : unavailable();
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
    async openSet(a) {
      const prior = await set(a, a.setId);
      if (prior) return prior.fileCount === a.fileCount && prior.totalBytes === a.totalBytes ? { kind: 'opened', repeated: true } : { kind: 'set-reused' };
      // The migration's insert trigger refuses an id an upload or a revision uses; the guard here keeps that a refusal, not a fault.
      await db.prepare(`INSERT INTO submissions_set (client_id, case_id, set_id, file_count, total_bytes, state, files_sha256, principal_issuer, principal_subject, opened_at, sealed_at)
        SELECT ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM submissions_set WHERE client_id = ? AND case_id = ? AND set_id = ?)
          AND NOT EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = ? AND case_id = ? AND operation_id = ?)
          AND NOT EXISTS (SELECT 1 FROM submissions_revision WHERE client_id = ? AND case_id = ? AND operation_id = ?)`)
        .bind(a.clientId, a.caseId, a.setId, a.fileCount, a.totalBytes, a.principal.issuer, a.principal.subject, a.at, a.clientId, a.caseId, a.setId, a.clientId, a.caseId, a.setId, a.clientId, a.caseId, a.setId)
        .run().catch(unavailable);
      const row = await set(a, a.setId);
      if (!row) return { kind: 'set-reused' };
      return row.fileCount === a.fileCount && row.totalBytes === a.totalBytes ? { kind: 'opened', repeated: false } : { kind: 'set-reused' };
    },
    set: (a) => set(a, a.setId),
    async sets(a) {
      const rows = await db.prepare(`${SET} WHERE s.client_id = ? AND s.case_id = ? ORDER BY s.opened_at, s.set_id`).bind(a.clientId, a.caseId).all<SetRow>().catch(unavailable);
      return rows.results.map((r) => setRecord(a, r));
    },
    async setOf(a) {
      const r = await db.prepare('SELECT set_id FROM submissions_set_member WHERE client_id = ? AND case_id = ? AND operation_id = ?')
        .bind(a.clientId, a.caseId, a.operationId).first<{ set_id: string }>().catch(unavailable);
      return r?.set_id ?? null;
    },
    async declareSetFile(a) {
      const prior = await upload(a, a.operationId);
      if (prior) {
        const owner = await db.prepare('SELECT set_id, path_key FROM submissions_set_member WHERE client_id = ? AND case_id = ? AND operation_id = ?')
          .bind(a.clientId, a.caseId, a.operationId).first<{ set_id: string; path_key: string }>().catch(unavailable);
        return owner?.set_id === a.setId && owner.path_key === a.pathKey && same(prior, a) ? { kind: 'declared', repeated: true } : { kind: 'operation-reused' };
      }
      const why = async (): Promise<{ kind: 'no-set' | 'set-closed' | 'set-full' | 'path-taken' | 'operation-reused' } | null> => {
        const s = await set(a, a.setId);
        if (!s) return { kind: 'no-set' };
        if (s.state !== 'open') return { kind: 'set-closed' };
        if (s.declared >= s.fileCount) return { kind: 'set-full' };
        const taken = await db.prepare('SELECT 1 AS x FROM submissions_set_member WHERE client_id = ? AND case_id = ? AND set_id = ? AND path_key = ?')
          .bind(a.clientId, a.caseId, a.setId, a.pathKey).first().catch(unavailable);
        if (taken) return { kind: 'path-taken' };
        if (await set(a, a.operationId)) return { kind: 'operation-reused' };
        return null;
      };
      // Every refusal is decided before the write, so a refused file leaves no row; the triggers refuse the same cases if a
      // concurrent request changes the set between this read and the batch, and the batch then writes nothing.
      const refusal = await why();
      if (refusal) return refusal;
      try {
        await db.batch([
          db.prepare(`INSERT INTO submissions_upload (client_id, case_id, operation_id, asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`)
            .bind(a.clientId, a.caseId, a.operationId, a.assetId, a.path, a.filename, a.mediaType, a.size, a.sha256, a.principal.issuer, a.principal.subject, a.at),
          db.prepare('INSERT INTO submissions_set_member (client_id, case_id, set_id, operation_id, path_key) VALUES (?, ?, ?, ?, ?)')
            .bind(a.clientId, a.caseId, a.setId, a.operationId, a.pathKey),
        ]);
      } catch {
        // Lost answer or a concurrent change: read again. Only this exact declaration in this set is success.
        const now = await upload(a, a.operationId);
        if (now) {
          const owner = await db.prepare('SELECT set_id FROM submissions_set_member WHERE client_id = ? AND case_id = ? AND operation_id = ?')
            .bind(a.clientId, a.caseId, a.operationId).first<{ set_id: string }>().catch(unavailable);
          return owner?.set_id === a.setId && same(now, a) ? { kind: 'declared', repeated: false } : { kind: 'operation-reused' };
        }
        return (await why()) ?? unavailable();
      }
      return { kind: 'declared', repeated: false };
    },
    async setFiles(a) {
      const rows = await db.prepare(`SELECT u.operation_id, u.asset_id, u.path, u.filename, u.media_type, u.size, u.sha256, u.state, m.path_key
          FROM submissions_set_member m JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
          WHERE m.client_id = ? AND m.case_id = ? AND m.set_id = ? AND m.path_key > ? ${a.state ? 'AND u.state = ?' : ''} ORDER BY m.path_key LIMIT ?`)
        .bind(...[a.clientId, a.caseId, a.setId, a.after ?? '', ...(a.state ? [a.state] : []), a.limit]).all<UploadRow & { path_key: string }>().catch(unavailable);
      return rows.results.map((r) => ({ upload: record(a, r), pathKey: r.path_key }));
    },
    async reserveSet(a) {
      const existing = await revision(a, a.setId);
      if (existing) return existing;
      const s = await set(a, a.setId);
      if (!s || s.state !== 'open') return unavailable();
      const id = revisionIdOf(a.setId);
      try {
        await db.batch([
          // the migration's triggers refuse the seal unless every declared file is stored with exactly the declared count and bytes
          db.prepare("UPDATE submissions_set SET state = 'sealing', files_sha256 = ? WHERE client_id = ? AND case_id = ? AND set_id = ? AND state = 'open'")
            .bind(a.filesSha256, a.clientId, a.caseId, a.setId),
          db.prepare(`INSERT INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at)
            SELECT ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM submissions_revision WHERE client_id = ? AND case_id = ?), set_id, file_count, ?
            FROM submissions_set WHERE client_id = ? AND case_id = ? AND set_id = ? AND state = 'sealing' AND files_sha256 = ?`)
            .bind(a.clientId, a.caseId, id, a.clientId, a.caseId, a.at, a.clientId, a.caseId, a.setId, a.filesSha256),
          db.prepare(`INSERT INTO submissions_file (client_id, case_id, revision_id, path, path_key, filename, media_type, size, sha256, asset_id)
            SELECT u.client_id, u.case_id, ?, u.path, m.path_key, u.filename, u.media_type, u.size, u.sha256, u.asset_id
            FROM submissions_set_member m JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
            WHERE m.client_id = ? AND m.case_id = ? AND m.set_id = ?`)
            .bind(id, a.clientId, a.caseId, a.setId),
          db.prepare(`UPDATE submissions_upload SET state = 'reserved' WHERE client_id = ? AND case_id = ? AND state = 'stored'
            AND operation_id IN (SELECT operation_id FROM submissions_set_member WHERE client_id = ? AND case_id = ? AND set_id = ?)`)
            .bind(a.clientId, a.caseId, a.clientId, a.caseId, a.setId),
        ]);
      } catch {
        const now = await revision(a, a.setId);
        if (now) return now;
        return unavailable();
      }
      const out = await revision(a, a.setId);
      // A batch that updated nothing (another seal or a refusal) recorded no revision: never report one.
      if (!out || out.files.length !== s.fileCount) return unavailable();
      return out;
    },
    async markSetFilesFinalized(a) {
      if (a.operationIds.length === 0) return;
      if (a.operationIds.length > 90) throw new RangeError('at most 90 files per mark');
      await db.prepare(`UPDATE submissions_upload SET state = 'finalized' WHERE client_id = ? AND case_id = ? AND state = 'reserved'
          AND operation_id IN (${a.operationIds.map(() => '?').join(', ')})
          AND operation_id IN (SELECT operation_id FROM submissions_set_member WHERE client_id = ? AND case_id = ? AND set_id = ?)`)
        .bind(a.clientId, a.caseId, ...a.operationIds, a.clientId, a.caseId, a.setId).run().catch(unavailable);
    },
    async commitSet(a) {
      const s = await set(a, a.setId);
      if (!s || s.state === 'open') return unavailable();
      if (s.state === 'sealing') {
        await db.prepare("UPDATE submissions_set SET state = 'sealed', sealed_at = ? WHERE client_id = ? AND case_id = ? AND set_id = ? AND state = 'sealing'")
          .bind(a.at, a.clientId, a.caseId, a.setId).run().catch(unavailable);
        if ((await set(a, a.setId))?.state !== 'sealed') return unavailable();
      }
      return (await revision(a, a.setId)) ?? unavailable();
    },
    revision: (a) => revision(a, a.operationId),
    async list(a) {
      const rows = await db.prepare(`${UPLOAD} u WHERE client_id = ? AND case_id = ? AND NOT ${MEMBER} ORDER BY declared_at, operation_id`).bind(a.clientId, a.caseId).all<UploadRow>().catch(unavailable);
      const out = [];
      for (const r of rows.results) out.push({ upload: record(a, r), manifest: r.state === 'finalized' ? await revision(a, r.operation_id) : null });
      return out;
    },
  };
}
