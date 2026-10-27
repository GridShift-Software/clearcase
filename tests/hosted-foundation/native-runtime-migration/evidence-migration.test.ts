// Synthetic SQLite migration evidence, not provider evidence.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import { assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS, assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS, prepareNativeEvidenceMigration, readNativeEvidenceMigration, checkNativeEvidenceMigrationInvocation } from '../../../deploy/native-alpha/runtime-migration.ts';

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
    expect(() => db.exec(`INSERT OR REPLACE INTO pub_evidence_item VALUES ('c','g','i','{"changed":true}')`)).toThrow();
    expect(() => db.exec(`INSERT OR REPLACE INTO pub_evidence_page VALUES ('c','g',0,'${'b'.repeat(64)}',1)`)).toThrow();
    const sealed = snapshot(db);
    try { migrate(db, sql); } catch { /* migration ledger or CREATE can refuse replay */ }
    expect(snapshot(db)).toEqual(sealed);
    db.close();
  });
  it('rolls back the whole increment on a mid-migration failure', () => {
    const db = world(), before = snapshot(db);
    const sql = assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql;
    expect(() => migrate(db, `${sql}\nINSERT INTO absent_synthetic_table VALUES (1);`)).toThrow();
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
  it('pins its inputs and stages a distinct, tamper-evident 0005 packet', () => {
    const inputs = sources(NATIVE_EVIDENCE_MIGRATION_INPUTS);
    const plan = assembleNativeEvidenceMigration(inputs);
    expect(plan.manifest.output.path).toBe('migrations/0005_native_evidence.sql');
    expect(plan.manifest.appliedRenderCaseLimitDependency.path).toBe('migrations/0004_native_render_case_limit.sql');
    inputs[0]!.bytes[0] ^= 1;
    expect(() => assembleNativeEvidenceMigration(inputs)).toThrow();
    const root = process.cwd(), dir = mkdtempSync(path.join(tmpdir(), 'cc-evidence-'));
    try {
      const staged = prepareNativeEvidenceMigration({ root, out: path.join(dir, 'stage') });
      expect(readNativeEvidenceMigration({ root, stage: staged.stage }).sql).toBe(plan.sql);
      for (const target of staged.manifest.targets) {
        expect(checkNativeEvidenceMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: target.argv }).target).toEqual(target);
        expect(() => checkNativeEvidenceMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: [...target.argv, '--local'] })).toThrow();
      }
      writeFileSync(path.join(staged.stage, plan.manifest.output.path), 'tampered');
      expect(() => readNativeEvidenceMigration({ root, stage: staged.stage })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
