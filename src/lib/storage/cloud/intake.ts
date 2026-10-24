import type { CaseId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { digest } from '../../server/runtime/data.ts';
import { storageAccess } from './access.ts';
import type { StorageContext } from './context.ts';
import { guard } from './d1.ts';
import { originalKey } from './keys.ts';
import { verifiedRead, writeOnce } from './objects.ts';

export interface DeclaredOriginal { caseId: CaseId; operationId: string; assetId: string; filename: string; mediaType: string; size: number; sha256: string }
export type IntakeRefusal = 'over-budget' | 'unknown-case' | 'not-declared' | 'operation-reused' | 'invalid-declaration' | 'digest-mismatch' | 'conflicting-object' | 'asset-bound-to-another-original';
export type IntakeOutcome = { kind: 'declared' | 'stored' | 'finalized'; repeated: boolean } | { kind: 'refused'; reason: IntakeRefusal };
/**
 * Client original upload at the storage level (the client upload controller, GRS-28, authorizes the caller and owns
 * the route). `declare` records the upload before any byte is written, `put` writes the declared bytes write-once
 * under `orig/<sha256>`, and `finalize` hashes the stored object whole and binds the asset to the case in one batch.
 * Only `finalize` makes an original visible; nothing here touches results or publication.
 */
export interface OriginalIntake {
  declare(a: DeclaredOriginal): Promise<IntakeOutcome>;
  put(a: { caseId: CaseId; operationId: string; bytes: Uint8Array }): Promise<IntakeOutcome>;
  finalize(a: { caseId: CaseId; operationId: string }): Promise<IntakeOutcome>;
}

type Upload = { asset_id: string; sha256: string; size: number; filename: string; media_type: string; state: 'declared' | 'finalized' };
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const refused = (reason: IntakeRefusal): IntakeOutcome => ({ kind: 'refused', reason });
const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const validText = (s: unknown, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max && s.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(s);

export function createOriginalIntake(ctx: StorageContext): OriginalIntake {
  const open = storageAccess(ctx, 'storage-unavailable');
  async function upload(s: Awaited<ReturnType<typeof open>>, caseId: CaseId, operationId: string) {
    return s.db.prepare('SELECT asset_id, sha256, size, filename, media_type, state FROM rs_original_upload WHERE case_id = ? AND operation_id = ?').bind(caseId, operationId).first<Upload>().catch(unavailable);
  }
  return {
    async declare(a) {
      const s = await open();
      if (!OPAQUE.test(a.operationId) || !OPAQUE.test(a.assetId) || !/^[0-9a-f]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 0 || !validText(a.filename, 255) || !validText(a.mediaType, 127)) return refused('invalid-declaration');
      if (a.size > s.budgets.maxOriginalBytes) return refused('over-budget');
      if (!(await s.db.prepare('SELECT 1 AS x FROM rs_case WHERE case_id = ?').bind(a.caseId).first().catch(unavailable))) return refused('unknown-case');
      const prior = await upload(s, a.caseId, a.operationId);
      if (prior) return prior.asset_id === a.assetId && prior.sha256 === a.sha256 && prior.size === a.size && prior.filename === a.filename && prior.media_type === a.mediaType ? { kind: 'declared', repeated: true } : refused('operation-reused');
      await s.db.prepare("INSERT INTO rs_original_upload (case_id, operation_id, asset_id, sha256, size, filename, media_type, state, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?) ON CONFLICT DO NOTHING")
        .bind(a.caseId, a.operationId, a.assetId, a.sha256, a.size, a.filename, a.mediaType, ctx.now().toISOString()).run().catch(unavailable);
      const row = await upload(s, a.caseId, a.operationId);
      return row?.asset_id === a.assetId && row.sha256 === a.sha256 && row.size === a.size ? { kind: 'declared', repeated: false } : refused('operation-reused');
    },
    async put(a) {
      const s = await open();
      const u = await upload(s, a.caseId, a.operationId);
      if (!u) return refused('not-declared');
      if (a.bytes.byteLength > s.budgets.maxOriginalBytes) return refused('over-budget');
      if (a.bytes.byteLength !== u.size || (await digest(a.bytes)) !== u.sha256) return refused('digest-mismatch');
      const w = await writeOnce(s.bucket, originalKey(u.sha256), a.bytes, u.sha256);
      if (w === 'unreachable') unavailable();
      if (w === 'conflict') return refused('conflicting-object');
      return { kind: 'stored', repeated: w === 'present' };
    },
    async finalize(a) {
      const s = await open();
      const u = await upload(s, a.caseId, a.operationId);
      if (!u) return refused('not-declared');
      const bound = await s.db.prepare('SELECT sha256 FROM rs_case_original WHERE case_id = ? AND asset_id = ?').bind(a.caseId, u.asset_id).first<{ sha256: string }>().catch(unavailable);
      if (bound && bound.sha256 !== u.sha256) return refused('asset-bound-to-another-original');
      if (u.state === 'finalized' && bound) return { kind: 'finalized', repeated: true };
      // The stored object is hashed whole before any row names it; a mismatch records nothing and deletes nothing.
      const key = originalKey(u.sha256);
      const read = await verifiedRead(s.bucket, key, { size: u.size, sha256: u.sha256 }, s.budgets.maxBufferedObjectBytes);
      if (read.kind === 'unreachable') unavailable();
      if (read.kind === 'over-budget') return refused('over-budget');
      if (read.kind !== 'ok') return refused('digest-mismatch');
      const at = ctx.now().toISOString();
      try {
        await s.db.batch([
          // the upload is still this declaration, the original's size agrees, and the asset is free or already this original
          guard(s.db, "EXISTS (SELECT 1 FROM rs_original_upload WHERE case_id = ? AND operation_id = ? AND sha256 = ? AND size = ?) AND NOT EXISTS (SELECT 1 FROM rs_original WHERE sha256 = ? AND size <> ?) AND NOT EXISTS (SELECT 1 FROM rs_case_original WHERE case_id = ? AND asset_id = ? AND sha256 <> ?)",
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
