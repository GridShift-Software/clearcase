// Synthetic SQLite migration evidence, not provider evidence.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import { assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS, assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS } from '../../../deploy/native-alpha/runtime-migration.ts';

const sources = (pins: readonly {path: string}[]) => pins.map(p => ({ path: p.path, bytes: readFileSync(p.path) }));
function migrate(db: DatabaseSync, sql: string) {
  db.exec('BEGIN');
  try { db.exec(sql); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function world() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
  db.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
  migrate(db, assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
  db.exec(`INSERT INTO npr_reservations (token,client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version,binding_sha256,day,started_ms,lease_ms,case_limit,client_limit)
    VALUES ('token','client','case','candidate','version','asset','${'a'.repeat(64)}',123,'renderer','${'b'.repeat(64)}',1,86400000,82000,3,4)`);
  return db;
}
function snapshot(db: DatabaseSync) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  return tables.map(t => ({ ...t, rows: db.prepare(`SELECT * FROM "${t.name.replaceAll('"', '""')}"`).all() }));
}
describe('0005 evidence increment', () => {
  it('preserves every existing table and row, seals items and pages, and safely refuses replay', () => {
    const db = world();
    const before = snapshot(db);
    const sql = assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql;
    expect(sql).not.toMatch(/\b(ALTER|DROP)\s+TABLE\b/i);
    migrate(db, sql);
    const after = snapshot(db);
    expect(after.filter(t => before.some(b => b.name === t.name))).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    db.exec(`INSERT INTO pub_evidence_item (candidate_id,generation,item_key,item_json) VALUES ('c','g','i','{}');
      INSERT INTO pub_evidence_page (candidate_id,generation,page_number,page_sha256,item_count) VALUES ('c','g',0,'${'a'.repeat(64)}',1);`);
    for (const table of ['pub_evidence_item', 'pub_evidence_page']) {
      expect(() => db.exec(`UPDATE ${table} SET candidate_id='other'`)).toThrow();
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow();
    }
    const sealed = snapshot(db);
    try { migrate(db, sql); } catch { /* migration ledger or CREATE can refuse replay */ }
    expect(snapshot(db)).toEqual(sealed);
    db.close();
  });
});
