import type { CaseId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { digest } from '../../server/runtime/data.ts';
import type { CloudD1 } from './bindings.ts';
import type { StorageContext } from './context.ts';
import { guard } from './d1.ts';
import { originalKey } from './keys.ts';
import { writerAccess } from './mutation.ts';
import { verifiedRead, writeOnce } from './objects.ts';

export interface DeclaredOriginal { caseId: CaseId; operationId: string; assetId: string; filename: string; mediaType: string; size: number; sha256: string }
export type IntakeRefusal = 'over-budget' | 'over-quota' | 'unknown-case' | 'not-declared' | 'operation-reused' | 'invalid-declaration' | 'digest-mismatch' | 'conflicting-object' | 'asset-bound-to-another-original';
export type IntakeOutcome = { kind: 'declared' | 'stored' | 'finalized'; repeated: boolean } | { kind: 'refused'; reason: IntakeRefusal };
/**
 * Client original upload at the storage level (the client upload controller, GRS-28, owns the route and the caller's
 * session). Every step first asks the injected capability check (`original.upload`, the deployment's client and the
 * case); without that callback every step is denied. `declare` reserves the case's and the client's upload and byte
 * quotas in D1 before any byte is written, `put` writes the declared bytes write-once under `orig/<sha256>` and records
 * that this operation sent them, and `finalize` binds the asset to the case, in one guarded batch, only for an
 * operation that did. A case therefore never binds an object it did not itself upload, whatever hash it names; and no
 * answer tells it whether another case holds the same bytes. Only `finalize` makes an original visible.
 */
export interface OriginalIntake {
  declare(a: DeclaredOriginal): Promise<IntakeOutcome>;
  put(a: { caseId: CaseId; operationId: string; bytes: Uint8Array }): Promise<IntakeOutcome>;
  finalize(a: { caseId: CaseId; operationId: string }): Promise<IntakeOutcome>;
}

type Upload = { asset_id: string; sha256: string; size: number; filename: string; media_type: string; state: 'declared' | 'stored' | 'finalized' };
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const refused = (reason: IntakeRefusal): IntakeOutcome => ({ kind: 'refused', reason });
const unavailable = (): never => { throw contractError('storage-unavailable', true); };
// Text a person will read in a file name or a type: no controls (C0, DEL, C1) and no bidirectional overrides or isolates.
const validText = (s: unknown, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max && s.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s);

export function createOriginalIntake(ctx: StorageContext): OriginalIntake {
  const open = writerAccess(ctx, 'original.upload');
  async function upload(s: { db: CloudD1 }, caseId: CaseId, operationId: string) {
    return s.db.prepare('SELECT asset_id, sha256, size, filename, media_type, state FROM rs_original_upload WHERE case_id = ? AND operation_id = ?').bind(caseId, operationId).first<Upload>().catch(unavailable);
  }
  const same = (u: Upload, a: DeclaredOriginal) => u.asset_id === a.assetId && u.sha256 === a.sha256 && u.size === a.size && u.filename === a.filename && u.media_type === a.mediaType;
  return {
    async declare(a) {
      const s = await open('declare', a.caseId, a.operationId);
      if (!OPAQUE.test(a.operationId) || !OPAQUE.test(a.assetId) || !/^[0-9a-f]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 0 || !validText(a.filename, 255) || !validText(a.mediaType, 127)) return refused('invalid-declaration');
      if (a.size > s.budgets.maxOriginalBytes) return refused('over-budget');
      if (!(await s.db.prepare('SELECT 1 AS x FROM rs_case WHERE case_id = ?').bind(a.caseId).first().catch(unavailable))) return refused('unknown-case');
      const prior = await upload(s, a.caseId, a.operationId);
      if (prior) return same(prior, a) ? { kind: 'declared', repeated: true } : refused('operation-reused');
      // The reservation: one statement that inserts the declaration only while the case's upload count, the case's bytes and
      // the client's bytes stay within their quotas. A repeat of this operation never reaches it, so a retry reserves nothing.
      const q = s.quotas;
      await s.db.prepare(`INSERT INTO rs_original_upload (case_id, operation_id, asset_id, sha256, size, filename, media_type, state, declared_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'declared', ? WHERE (SELECT COUNT(*) FROM rs_original_upload WHERE case_id = ?) < ?
          AND (SELECT COALESCE(SUM(size), 0) FROM rs_original_upload WHERE case_id = ?) + ? <= ?
          AND (SELECT COALESCE(SUM(size), 0) FROM rs_original_upload) + ? <= ?
        ON CONFLICT DO NOTHING`)
        .bind(a.caseId, a.operationId, a.assetId, a.sha256, a.size, a.filename, a.mediaType, ctx.now().toISOString(), a.caseId, q.maxUploadsPerCase, a.caseId, a.size, q.maxOriginalBytesPerCase, a.size, q.maxOriginalBytesPerClient).run().catch(unavailable);
      const row = await upload(s, a.caseId, a.operationId);
      if (!row) return refused('over-quota');
      return same(row, a) ? { kind: 'declared', repeated: false } : refused('operation-reused');
    },
    async put(a) {
      const s = await open('put', a.caseId, a.operationId);
      const u = await upload(s, a.caseId, a.operationId);
      if (!u) return refused('not-declared');
      if (a.bytes.byteLength > s.budgets.maxOriginalBytes) return refused('over-budget');
      if (a.bytes.byteLength !== u.size || (await digest(a.bytes)) !== u.sha256) return refused('digest-mismatch');
      // This operation already sent its bytes: nothing more reaches the bucket, whoever else holds the same bytes.
      if (u.state !== 'declared') return { kind: 'stored', repeated: true };
      // The attempt is reserved in D1 before the bucket is touched; a retry spends from the same budget and never resets it.
      const reserved = await s.db.prepare("UPDATE rs_original_upload SET put_attempts = put_attempts + 1 WHERE case_id = ? AND operation_id = ? AND state = 'declared' AND put_attempts < ? RETURNING put_attempts")
        .bind(a.caseId, a.operationId, s.quotas.maxPutAttemptsPerUpload).all<{ put_attempts: number }>().catch(unavailable);
      if (reserved.results.length === 0) return (await upload(s, a.caseId, a.operationId))?.state === 'declared' ? refused('over-quota') : { kind: 'stored', repeated: true };
      const w = await writeOnce(s.bucket, originalKey(u.sha256), a.bytes, u.sha256);
      if (w === 'unreachable') unavailable();
      if (w === 'conflict') return refused('conflicting-object');
      // The object is where this declaration says and holds the bytes this operation sent; the provenance is durable before finalize can use it.
      await s.db.prepare("UPDATE rs_original_upload SET state = 'stored', stored_at = ? WHERE case_id = ? AND operation_id = ? AND state = 'declared'").bind(ctx.now().toISOString(), a.caseId, a.operationId).run().catch(unavailable);
      // `repeated` is about this operation only: the same answer whether or not another case already holds these bytes.
      return { kind: 'stored', repeated: false };
    },
    async finalize(a) {
      const s = await open('finalize', a.caseId, a.operationId);
      const u = await upload(s, a.caseId, a.operationId);
      if (!u) return refused('not-declared');
      const bound = await s.db.prepare('SELECT sha256 FROM rs_case_original WHERE case_id = ? AND asset_id = ?').bind(a.caseId, u.asset_id).first<{ sha256: string }>().catch(unavailable);
      if (bound && bound.sha256 !== u.sha256) return refused('asset-bound-to-another-original');
      if (u.state === 'finalized' && bound) return { kind: 'finalized', repeated: true };
      // Without this operation's own stored bytes there is nothing to finalize. The answer is the same as for a body that does
      // not hash to the declaration, so it does not tell the case whether the object exists under another case's upload.
      if (u.state === 'declared') return refused('digest-mismatch');
      // The stored object is hashed whole before any row names it; a mismatch records nothing and deletes nothing.
      const key = originalKey(u.sha256);
      const read = await verifiedRead(s.bucket, key, { size: u.size, sha256: u.sha256 }, s.budgets.maxBufferedObjectBytes);
      if (read.kind === 'unreachable') unavailable();
      if (read.kind === 'over-budget') return refused('over-budget');
      if (read.kind !== 'ok') return refused('digest-mismatch');
      const at = ctx.now().toISOString();
      try {
        await s.db.batch([
          // the upload is still this declaration and was stored by this operation, the original's size agrees, and the asset is free or already this original
          guard(s.db, "EXISTS (SELECT 1 FROM rs_original_upload WHERE case_id = ? AND operation_id = ? AND sha256 = ? AND size = ? AND state IN ('stored', 'finalized')) AND NOT EXISTS (SELECT 1 FROM rs_original WHERE sha256 = ? AND size <> ?) AND NOT EXISTS (SELECT 1 FROM rs_case_original WHERE case_id = ? AND asset_id = ? AND sha256 <> ?)",
            a.caseId, a.operationId, u.sha256, u.size, u.sha256, u.size, a.caseId, u.asset_id, u.sha256),
          s.db.prepare('INSERT INTO rs_original (sha256, size, object_key) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING').bind(u.sha256, u.size, key),
          s.db.prepare('INSERT INTO rs_case_original (case_id, asset_id, sha256, filename, media_type, finalized_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (case_id, asset_id) DO NOTHING').bind(a.caseId, u.asset_id, u.sha256, u.filename, u.media_type, at),
          s.db.prepare("UPDATE rs_original_upload SET state = 'finalized' WHERE case_id = ? AND operation_id = ?").bind(a.caseId, a.operationId),
        ]);
      } catch {
        // A guard refusal and a D1 fault look alike from here: read the state again to tell them apart.
        const now = await s.db.prepare('SELECT sha256 FROM rs_case_original WHERE case_id = ? AND asset_id = ?').bind(a.caseId, u.asset_id).first<{ sha256: string }>().catch(unavailable);
        if (now && now.sha256 !== u.sha256) return refused('asset-bound-to-another-original');
        unavailable();
      }
      return { kind: 'finalized', repeated: !!bound };
    },
  };
}
