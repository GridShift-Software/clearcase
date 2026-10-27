// Synthetic SQLite migration evidence, not provider evidence.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import {
  assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS,
  assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS, NATIVE_IMPORT_STAGING_APPLIED_EVIDENCE, NATIVE_IMPORT_STAGING_MIGRATION_INPUTS,
  assembleNativeImportStagingMigration, prepareNativeImportStagingMigration, readNativeImportStagingMigration, checkNativeImportStagingMigrationInvocation,
} from '../../../deploy/native-alpha/runtime-migration.ts';

const sources = (pins: readonly { path: string }[]) => pins.map((p) => ({ path: p.path, bytes: readFileSync(p.path) }));
function migrate(db: DatabaseSync, sql: string) {
  db.exec('BEGIN');
  try { db.exec(sql); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// A D1 holding 0001, 0002, 0004 and 0005 exactly as the earlier packets emit them.
function world() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
  db.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
  migrate(db, assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
  migrate(db, assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql);
  db.exec(`INSERT INTO native_import_attempt (client_id, case_id, operation_id, kind, operator_issuer, operator_subject, request_sha256, submission_revision_id, base_candidate_id, declared_at)
    VALUES ('client','case','op','import','iss','sub','${'a'.repeat(64)}','rev',NULL,'2026-10-27T00:00:00Z')`);
  return db;
}
function snapshot(db: DatabaseSync) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  return { tables: tables.map((t) => ({ ...t, rows: db.prepare(`SELECT * FROM "${t.name.replaceAll('"', '""')}"`).all() })), triggers };
}
const session = (op: string) => `INSERT INTO native_import_session (client_id,case_id,operation_id,submission_revision_id,manifest_sha256,manifest_size,results_version,expected_files,expected_bytes,request_sha256,operator_issuer,operator_subject,opened_at)
  VALUES ('client','case','${op}','rev','${'b'.repeat(64)}',10,'sha256:${'c'.repeat(64)}',2,20,'${'d'.repeat(64)}','iss','sub','2026-10-27T00:00:00Z')`;

describe('0006 chunked-import staging increment', () => {
  it('adds only its own tables, keeps every earlier table and row byte-identical, and seals sessions and staged files', () => {
    const db = world();
    const before = snapshot(db);
    const sql = assembleNativeImportStagingMigration(sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).sql;
    expect(sql).not.toMatch(/\b(ALTER|DROP)\s+TABLE\b/i);
    migrate(db, sql);
    const after = snapshot(db);
    expect(after.tables.filter((t) => before.tables.some((b) => b.name === t.name))).toEqual(before.tables);
    expect(after.tables.map((t) => t.name).filter((n) => !before.tables.some((b) => b.name === n))).toEqual(['native_import_cleanup', 'native_import_session', 'native_import_stage_fact', 'native_import_stage_run', 'native_import_staged_file']);
    expect(after.triggers.filter((t) => before.triggers.some((b) => (b as { name: string }).name === (t as { name: string }).name))).toEqual(before.triggers);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    db.exec(session('op1'));
    db.exec(`INSERT INTO native_import_staged_file VALUES ('client','case','op1','datasets/a.json','${'e'.repeat(64)}',5,'2026-10-27T00:00:00Z')`);
    expect(() => db.exec(session('op1'))).toThrow();
    expect(() => db.exec(`INSERT INTO native_import_staged_file VALUES ('client','case','missing-session','datasets/a.json','${'e'.repeat(64)}',5,'t')`)).toThrow();
    expect(() => db.exec(`INSERT INTO native_import_staged_file VALUES ('client','case','op1','datasets/a.json','${'f'.repeat(64)}',5,'t')`)).toThrow();
    for (const table of ['native_import_session', 'native_import_staged_file']) {
      expect(() => db.exec(`UPDATE ${table} SET case_id='other'`)).toThrow();
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow();
    }
    expect(() => db.exec(`INSERT OR REPLACE INTO native_import_staged_file VALUES ('client','case','op1','datasets/a.json','${'f'.repeat(64)}',9,'t')`)).toThrow();
    const sealed = snapshot(db);
    try { migrate(db, sql); } catch { /* the ledger or CREATE can refuse replay */ }
    expect(snapshot(db)).toEqual(sealed);
    db.close();
  });
  it('keeps a stepped run\'s facts write-once, lets its run row move, and never deletes a run, a fact or a cleanup record', () => {
    const db = world();
    migrate(db, assembleNativeImportStagingMigration(sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).sql);
    db.exec(session('op1'));
    db.exec(`INSERT INTO native_import_stage_run (client_id,case_id,operation_id,epoch,phase,cursor,meta,steps,lease_id,lease_until_ms,updated_at)
      VALUES ('client','case','op1',0,'plan','{}','{}',0,'lease-a',100,'2026-10-27T00:00:00Z')`);
    db.exec(`UPDATE native_import_stage_run SET phase='originals-a', cursor='{"after":"k"}', steps=1, lease_until_ms=0 WHERE operation_id='op1'`);
    expect(db.prepare("SELECT phase, steps FROM native_import_stage_run WHERE operation_id='op1'").get()).toEqual({ phase: 'originals-a', steps: 1 });
    // A run cannot be moved to a phase the machine does not have, nor given to another operation, nor go back an epoch.
    expect(() => db.exec(`UPDATE native_import_stage_run SET phase='nonsense' WHERE operation_id='op1'`)).toThrow();
    expect(() => db.exec(`UPDATE native_import_stage_run SET operation_id='op2' WHERE operation_id='op1'`)).toThrow();
    db.exec(`UPDATE native_import_stage_run SET epoch=1 WHERE operation_id='op1'`);
    expect(() => db.exec(`UPDATE native_import_stage_run SET epoch=0 WHERE operation_id='op1'`)).toThrow();
    expect(() => db.exec(`DELETE FROM native_import_stage_run`)).toThrow();
    expect(() => db.exec(`INSERT INTO native_import_stage_run (client_id,case_id,operation_id,epoch,phase,cursor,meta,steps,lease_id,lease_until_ms,updated_at)
      VALUES ('client','case','missing-session',0,'plan','{}','{}',0,NULL,0,'t')`)).toThrow();
    const fact = (key: string, value = '{}') => `INSERT INTO native_import_stage_fact (client_id,case_id,operation_id,epoch,pass,key,value) VALUES ('client','case','op1',1,'a','${key}','${value}')`;
    db.exec(fact('K1'));
    expect(() => db.exec(fact('K1', '{"x":1}'))).toThrow();
    expect(() => db.exec(`INSERT OR REPLACE INTO native_import_stage_fact (client_id,case_id,operation_id,epoch,pass,key,value) VALUES ('client','case','op1',1,'a','K1','{"x":2}')`)).toThrow();
    expect(() => db.exec(`UPDATE native_import_stage_fact SET value='{}'`)).toThrow();
    expect(() => db.exec(`DELETE FROM native_import_stage_fact`)).toThrow();
    db.exec(`INSERT INTO native_import_cleanup (client_id,case_id,operation_id,reason,after_path,swept,state,started_at,finished_at) VALUES ('client','case','op1','complete','',0,'sweeping','2026-10-27T00:00:00Z',NULL)`);
    db.exec(`UPDATE native_import_cleanup SET after_path='datasets/a.json', swept=3 WHERE operation_id='op1'`);
    db.exec(`UPDATE native_import_cleanup SET state='done', finished_at='2026-10-27T00:01:00Z' WHERE operation_id='op1'`);
    expect(() => db.exec(`UPDATE native_import_cleanup SET state='sweeping' WHERE operation_id='op1'`)).toThrow();
    expect(() => db.exec(`DELETE FROM native_import_cleanup`)).toThrow();
    expect(() => db.exec(`INSERT INTO native_import_cleanup (client_id,case_id,operation_id,reason,after_path,swept,state,started_at,finished_at) VALUES ('client','case','op1','abandoned','',0,'sweeping','t',NULL)`)).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
  it('rolls back the whole increment on a mid-migration failure', () => {
    const db = world(), before = snapshot(db);
    const sql = assembleNativeImportStagingMigration(sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).sql;
    expect(() => migrate(db, `${sql}\nINSERT INTO absent_synthetic_table VALUES (1);`)).toThrow();
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
  it('depends on the 0005 the evidence packet emits, pins its input, and stages a distinct, tamper-evident 0006 packet', () => {
    const emitted005 = assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).manifest.output;
    expect(NATIVE_IMPORT_STAGING_APPLIED_EVIDENCE).toEqual(emitted005);
    const inputs = sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS);
    const plan = assembleNativeImportStagingMigration(inputs);
    expect(plan.manifest.output.path).toBe('migrations/0006_native_import_staging.sql');
    inputs[0]!.bytes[0] ^= 1;
    expect(() => assembleNativeImportStagingMigration(inputs)).toThrow();
    const root = process.cwd(), dir = mkdtempSync(path.join(tmpdir(), 'cc-staging-'));
    try {
      const staged = prepareNativeImportStagingMigration({ root, out: path.join(dir, 'stage') });
      expect(readNativeImportStagingMigration({ root, stage: staged.stage }).sql).toBe(plan.sql);
      for (const target of staged.manifest.targets) {
        expect(checkNativeImportStagingMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: target.argv }).target).toEqual(target);
        expect(() => checkNativeImportStagingMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: [...target.argv, '--local'] })).toThrow();
      }
      writeFileSync(path.join(staged.stage, plan.manifest.output.path), 'tampered');
      expect(() => readNativeImportStagingMigration({ root, stage: staged.stage })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
