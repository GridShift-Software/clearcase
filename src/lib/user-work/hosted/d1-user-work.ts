// RED skeleton (replaced by the implementation): a naive register write with no expected-version guard or audit.
import type * as C from '../../server/runtime/contracts.ts';
import type { D1 } from '../../server/runtime/hosted/bindings.ts';
import { id } from '../../server/runtime/ids.ts';
export interface D1UserWorkConfig { clientId: C.ClientId; limits: { maxStatementsPerBatch: number; maxSnapshotBytes: number } }
export interface D1UserWorkOptions { db: D1; config: D1UserWorkConfig; identity: C.Identity; audit: C.AuditSink; store: C.CaseReader; now: () => Date }
export function createD1UserWork(o: D1UserWorkOptions): C.AsyncUserWork {
  const missing = async (): Promise<never> => { throw new Error('not implemented'); };
  const work = {
    async listRows(a: C.Scope & { store: string }) {
      const rows = (await o.db.prepare('SELECT row_id, store, fields_json, version FROM uw_register_row WHERE case_id = ? AND store = ? ORDER BY rowid').bind(a.caseId, a.store).all<{ row_id: string; store: string; fields_json: string; version: string }>()).results;
      return rows.map((r) => ({ rowId: r.row_id, store: r.store, anchor: null, fields: JSON.parse(r.fields_json), createdAt: '', updatedAt: '', intact: true, version: id('row-version', r.version) }));
    },
    async putRow(a: C.WriteScope & { store: string; rowId: string | null; fields: C.Fields; anchor: C.Anchor | null }) {
      const rowId = a.rowId ?? crypto.randomUUID(), version = id('row-version', crypto.randomUUID()), at = o.now().toISOString();
      await o.db.batch([o.db.prepare('INSERT INTO uw_register_row (case_id, store, row_id, anchor_json, fields_json, fields_sha256, created_at, updated_at, version) VALUES (?,?,?,NULL,?,?,?,?,?) ON CONFLICT(case_id, store, row_id) DO UPDATE SET fields_json = excluded.fields_json, version = excluded.version').bind(a.caseId, a.store, rowId, JSON.stringify(a.fields), 'x'.repeat(64), at, at, version)]);
      return { kind: 'written' as const, value: { rowId, repeated: false }, version, caseRevision: id('case-revision', crypto.randomUUID()) };
    },
  };
  return new Proxy(work as unknown as C.AsyncUserWork, { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : missing) });
}
