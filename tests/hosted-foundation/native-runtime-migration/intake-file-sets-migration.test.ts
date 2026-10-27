// Synthetic SQLite migration evidence, not provider evidence. 0007 rebuilds submissions_revision (its one-file CHECK and its
// upload foreign key) by copying the rows back under the same name, and adds the file-set tables.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import {
  assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS,
  assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS, assembleNativeImportStagingMigration, NATIVE_IMPORT_STAGING_MIGRATION_INPUTS,
  NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS, NATIVE_INTAKE_FILE_SETS_APPLIED_IMPORT_STAGING, assembleNativeIntakeFileSetsMigration,
  prepareNativeIntakeFileSetsMigration, readNativeIntakeFileSetsMigration, checkNativeIntakeFileSetsMigrationInvocation,
} from '../../../deploy/native-alpha/runtime-migration.ts';
import { d1SubmissionRepository, type IntakeD1, type IntakeD1Value } from '../../../src/lib/submissions/index.ts';
import { submissionSnapshotReader } from '../../../src/lib/results-review/native/submission-reader.ts';
import type { CaseId, ClientId } from '../../../src/lib/server/runtime/contracts.ts';

const sources = (pins: readonly { path: string }[]) => pins.map((p) => ({ path: p.path, bytes: readFileSync(p.path) }));
function migrate(db: DatabaseSync, sql: string) {
  db.exec('BEGIN');
  try { db.exec(sql); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const SHA = (c: string) => c.repeat(64);
const AT = '2026-10-20T00:00:00Z';
const upload = (op: string, p: string, sha: string) => `INSERT INTO submissions_upload (client_id, case_id, operation_id, asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at)
  VALUES ('client-a', 'case-a', '${op}', 'sub-${op}', '${p}', '${p.split('/').pop()}', 'application/pdf', 10, '${sha}', 'received', 'iss', 'sub', '${AT}')`;
const stored = (op: string) => `UPDATE submissions_upload SET state = 'stored', stored_at = '${AT}' WHERE operation_id = '${op}'`;
const revision = (op: string, seq: number, p: string) => [
  `INSERT INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at) VALUES ('client-a', 'case-a', 'subrev-${op}', ${seq}, '${op}', 1, '${AT}')`,
  `INSERT INTO submissions_file (client_id, case_id, revision_id, path, path_key, filename, media_type, size, sha256, asset_id)
    SELECT client_id, case_id, 'subrev-${op}', path, '${p.toLowerCase()}', filename, media_type, size, sha256, asset_id FROM submissions_upload WHERE operation_id = '${op}'`,
];
// A D1 holding 0001, 0002, 0004, 0005 and 0006 exactly as the earlier packets emit them, with single-file submissions in every state.
function world() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
  db.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
  migrate(db, assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
  migrate(db, assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql);
  migrate(db, assembleNativeImportStagingMigration(sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).sql);
  const ops = { finalized: 'op-final-0000000001', second: 'op-final-0000000002', reserved: 'op-reserv-000000001', stored: 'op-stored-000000001', received: 'op-receiv-000000001' };
  for (const [k, op] of Object.entries(ops)) db.exec(upload(op, `Letters/${k}.pdf`, SHA(k[0]!)));
  for (const op of [ops.finalized, ops.second, ops.reserved, ops.stored]) db.exec(stored(op));
  [ops.finalized, ops.second, ops.reserved].forEach((op, i) => { for (const s of revision(op, i + 1, `Letters/${Object.keys(ops)[i]}.pdf`)) db.exec(s); });
  db.exec(`UPDATE submissions_upload SET state = 'reserved' WHERE operation_id = '${ops.reserved}'`);
  for (const op of [ops.finalized, ops.second]) db.exec(`UPDATE submissions_upload SET state = 'finalized' WHERE operation_id = '${op}'`);
  return { db, ops };
}
function snapshot(db: DatabaseSync) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  const triggers = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as { name: string; tbl_name: string; sql: string }[];
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
  return { tables: tables.map((t) => ({ ...t, rows: db.prepare(`SELECT * FROM "${t.name.replaceAll('"', '""')}"`).all() })), triggers, indexes };
}
function d1(db: DatabaseSync): IntakeD1 {
  const statement = (sql: string, values: IntakeD1Value[] = []): ReturnType<IntakeD1['prepare']> & { exec(): unknown[] } => ({
    bind: (...v: IntakeD1Value[]) => statement(sql, v),
    exec() { const q = db.prepare(sql); return /^\s*(SELECT|WITH)/i.test(sql) ? q.all(...values) : (q.run(...values), []); },
    async first<T>() { return ((this.exec() as T[])[0] ?? null) as T | null; },
    async all<T>() { return { results: this.exec() as T[] }; },
    async run() { return this.exec(); },
  });
  return { prepare: (sql) => statement(sql), async batch(ss) { db.exec('BEGIN'); try { const out = ss.map((s) => (s as unknown as { exec(): unknown }).exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
const SQL = () => assembleNativeIntakeFileSetsMigration(sources(NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS)).sql;
const REPLACED = ['submissions_file_insert_once', 'submissions_file_matches_declaration', 'submissions_upload_needs_revision'];
const scope = { clientId: 'client-a' as ClientId, caseId: 'case-a' as CaseId };

describe('0007 multi-file intake increment', () => {
  it('rebuilds submissions_revision by copy-back: every row and every other table byte-identical, old revisions readable', async () => {
    const { db, ops } = world();
    const repo = d1SubmissionRepository(d1(db)), reader = submissionSnapshotReader(d1(db) as never);
    const manifestBefore = await repo.revision({ ...scope, operationId: ops.finalized });
    const snapBefore = await reader.finalized({ ...scope, revisionId: `subrev-${ops.finalized}` });
    const before = snapshot(db);
    migrate(db, SQL());
    const after = snapshot(db);

    const kept = (s: ReturnType<typeof snapshot>) => s.tables.filter((t) => t.name !== 'submissions_revision' && before.tables.some((b) => b.name === t.name));
    expect(kept(after)).toEqual(kept(before));
    const rev = (s: ReturnType<typeof snapshot>) => s.tables.find((t) => t.name === 'submissions_revision')!;
    const byId = (rs: unknown[]) => [...rs].sort((x, y) => String((x as { revision_id: string }).revision_id).localeCompare(String((y as { revision_id: string }).revision_id)));
    expect(byId(rev(after).rows)).toEqual(byId(rev(before).rows));
    expect(rev(after).sql).toMatch(/CHECK \(file_count BETWEEN 1 AND 8192\)/);
    expect(rev(after).sql).not.toMatch(/REFERENCES submissions_upload/);
    expect(after.tables.map((t) => t.name).filter((n) => !before.tables.some((b) => b.name === n))).toEqual(['submissions_set', 'submissions_set_member']);
    // Every trigger the increment does not deliberately replace is byte-identical, the publication fence on revisions included.
    const untouched = (s: ReturnType<typeof snapshot>) => s.triggers.filter((t) => !REPLACED.includes(t.name) && before.triggers.some((b) => b.name === t.name));
    expect(untouched(after)).toEqual(before.triggers.filter((t) => !REPLACED.includes(t.name)));
    expect(after.triggers.map((t) => t.name)).toEqual(expect.arrayContaining(['pub_provenance_submissions_revision_insert', 'submissions_revision_insert_once', 'submissions_revision_immutable_update', 'submissions_revision_immutable_delete', ...REPLACED]));
    expect(after.indexes).toEqual(before.indexes);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    expect(await repo.revision({ ...scope, operationId: ops.finalized })).toEqual(manifestBefore);
    expect(await reader.finalized({ ...scope, revisionId: `subrev-${ops.finalized}` })).toEqual(snapBefore);
    expect(await reader.finalized({ ...scope, revisionId: `subrev-${ops.reserved}` })).toEqual({ state: 'not-final' });
    // The old single-file path still works over the rebuilt table: the stored upload reserves and finalizes the next sequence.
    const next = await repo.commitRevision({ ...scope, operationId: ops.stored, at: AT });
    expect(next).toMatchObject({ sequence: 4, files: [{ path: 'Letters/stored.pdf' }] });
    // The rebuilt table still refuses a second file, a skipped sequence, an update and a delete.
    expect(() => db.exec(`INSERT INTO submissions_file (client_id, case_id, revision_id, path, path_key, filename, media_type, size, sha256, asset_id)
      VALUES ('client-a', 'case-a', 'subrev-${ops.finalized}', 'Letters/x.pdf', 'letters/x.pdf', 'x.pdf', 'application/pdf', 10, '${SHA('f')}', 'sub-${ops.finalized}')`)).toThrow();
    expect(() => db.exec(revision(ops.received, 9, 'x')[0]!)).toThrow();
    expect(() => db.exec('UPDATE submissions_revision SET sequence = sequence + 10')).toThrow();
    expect(() => db.exec('DELETE FROM submissions_revision')).toThrow();
    db.close();
  });

  it('leaves no orphan: a copy-back that loses a revision fails the whole increment at commit', () => {
    const { db } = world(), before = snapshot(db);
    const sql = SQL();
    const copyBack = /INSERT INTO submissions_revision \([^)]*\)\s+SELECT[^;]*;/;
    expect(sql).toMatch(copyBack);
    expect(sql).toMatch(/PRAGMA defer_foreign_keys = on;/);
    expect(sql).not.toMatch(/defer_foreign_keys\s*=\s*off/i);
    expect(() => migrate(db, sql.replace(copyBack, ''))).toThrow(/FOREIGN KEY/);
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  it('rolls back the whole increment on a mid-migration failure, and refuses a replay', () => {
    const { db } = world(), before = snapshot(db);
    expect(() => migrate(db, `${SQL()}\nINSERT INTO absent_synthetic_table VALUES (1);`)).toThrow();
    expect(snapshot(db)).toEqual(before);
    migrate(db, SQL());
    const applied = snapshot(db);
    expect(() => migrate(db, SQL())).toThrow();
    expect(snapshot(db)).toEqual(applied);
    db.close();
  });

  it('depends on the 0006 the staging packet emits, pins its inputs, and stages a distinct, tamper-evident 0007 packet', () => {
    expect(NATIVE_INTAKE_FILE_SETS_APPLIED_IMPORT_STAGING).toEqual(assembleNativeImportStagingMigration(sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).manifest.output);
    const inputs = sources(NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS);
    const plan = assembleNativeIntakeFileSetsMigration(inputs);
    expect(plan.manifest.output.path).toBe('migrations/0007_native_intake_file_sets.sql');
    expect(inputs.map((i) => i.path)).toEqual(['src/lib/submissions/migrations/0002_submissions_file_sets.sql', 'src/lib/publication/hosted/migrations/0005_provenance_file_sets.sql']);
    inputs[0]!.bytes[0] ^= 1;
    expect(() => assembleNativeIntakeFileSetsMigration(inputs)).toThrow();
    const root = process.cwd(), dir = mkdtempSync(path.join(tmpdir(), 'cc-file-sets-'));
    try {
      const staged = prepareNativeIntakeFileSetsMigration({ root, out: path.join(dir, 'stage') });
      expect(readNativeIntakeFileSetsMigration({ root, stage: staged.stage }).sql).toBe(plan.sql);
      for (const target of staged.manifest.targets) {
        expect(checkNativeIntakeFileSetsMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: target.argv }).target).toEqual(target);
        expect(() => checkNativeIntakeFileSetsMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: [...target.argv, '--local'] })).toThrow();
      }
      writeFileSync(path.join(staged.stage, plan.manifest.output.path), 'tampered');
      expect(() => readNativeIntakeFileSetsMigration({ root, stage: staged.stage })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
