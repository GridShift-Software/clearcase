// Synthetic SQLite migration evidence, not provider evidence. U14: the upgrade sandbox B takes, from the schema it runs now
// (0001, 0002 and 0004 as their packets emit them, holding rows) through 0005, 0006, 0007 and the new 0008, in order, on a copy.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import * as nativePackets from '../../../deploy/native-alpha/runtime-migration.ts';
import {
  assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS,
  assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS, assembleNativeImportStagingMigration, NATIVE_IMPORT_STAGING_MIGRATION_INPUTS,
  assembleNativeIntakeFileSetsMigration, NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS, NATIVE_PDF_SESSIONS_APPLIED_INTAKE_FILE_SETS, NATIVE_PDF_SESSIONS_MIGRATION_INPUTS,
  NATIVE_PDF_SESSIONS_MIGRATION_MODE, assembleNativePdfSessionsMigration, prepareNativePdfSessionsMigration, readNativePdfSessionsMigration, checkNativePdfSessionsMigrationInvocation,
} from '../../../deploy/native-alpha/runtime-migration.ts';

const sources = (pins: readonly { path: string }[]) => pins.map((p) => ({ path: p.path, bytes: readFileSync(p.path) }));

it('the declared native install carries every source migration exactly once', () => {
  const declared = Object.entries(nativePackets).filter(([name]) => name.endsWith('_MIGRATION_INPUTS'))
    .flatMap(([, pins]) => (pins as readonly { path: string }[]).map(p => p.path));
  const carried = [...NATIVE_SCHEMA_INPUTS.map(p => p.path), ...declared];
  const disk = readdirSync('src/lib', { recursive: true, encoding: 'utf8' }).filter(p => /(?:^|\/)migrations\/[^/]+\.sql$/.test(p)).map(p => `src/lib/${p}`);
  expect([...carried].sort()).toEqual(disk.sort());
  expect(new Set(carried).size).toBe(carried.length);
  expect(nativePackets.NATIVE_MIGRATION_SEQUENCE.flatMap(packet => packet.inputs.map(p => p.path)).sort()).toEqual(declared.sort());
});

it('the workspace CLI packet upgrades the native prefix with shards, notifications and owned bundle definitions', () => {
  const db = new DatabaseSync(':memory:'), root = process.cwd(), dir = mkdtempSync(path.join(tmpdir(), 'cc-native-workspace-'));
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
    for (const packet of nativePackets.NATIVE_MIGRATION_SEQUENCE) {
      if (packet.mode !== nativePackets.NATIVE_WORKSPACE_MIGRATION_MODE) migrate(db, packet.assemble(sources(packet.inputs)).sql);
    }
    db.exec("INSERT INTO rs_case (case_id,case_label) VALUES ('case-existing','Synthetic existing case')");
    const stage = path.join(dir, 'stage');
    const cli = (...args: string[]) => spawnSync(process.execPath, ['scripts/hosted-native-runtime-migration.ts', ...args], { cwd: root, encoding: 'utf8' });
    const prepared = cli('prepare', stage, nativePackets.NATIVE_WORKSPACE_MIGRATION_MODE);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(cli('verify', stage, nativePackets.NATIVE_WORKSPACE_MIGRATION_MODE).status).toBe(0);
    const packet = nativePackets.readNativeWorkspaceMigration({ root, stage });
    expect(packet.manifest.appliedOriginalMetadataDependency).toEqual(nativePackets.assembleNativeOriginalMetadataMigration(sources(nativePackets.NATIVE_ORIGINAL_METADATA_MIGRATION_INPUTS)).manifest.output);
    migrate(db, packet.sql);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('rs_shard_manifest','rs_shard_entry','rs_shard_admission','sub_notification') ORDER BY name").all()).toHaveLength(4);
    expect(db.prepare("SELECT name FROM uw_table_definition WHERE name IN ('bundles_custom','bundles_schedule_mark') ORDER BY name").all()).toHaveLength(2);
    expect(db.prepare("SELECT case_label FROM rs_case WHERE case_id='case-existing'").get()).toEqual({ case_label: 'Synthetic existing case' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    for (const target of packet.manifest.targets) expect(nativePackets.checkNativeWorkspaceMigrationInvocation({ root, stage, cwd: stage, slot: target.slot, argv: target.argv }).target).toEqual(target);
    writeFileSync(path.join(stage, packet.manifest.output.path), 'tampered');
    expect(cli('verify', stage, nativePackets.NATIVE_WORKSPACE_MIGRATION_MODE).status).toBe(1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
function migrate(db: DatabaseSync, sql: string) {
  db.exec('BEGIN');
  try { db.exec(sql); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const AT = '2026-10-25T00:00:00Z', SHA = (c: string) => c.repeat(64);
const LATER = [
  () => assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql,
  () => assembleNativeImportStagingMigration(sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).sql,
  () => assembleNativeIntakeFileSetsMigration(sources(NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS)).sql,
] as const;
const SQL = () => assembleNativePdfSessionsMigration(sources(NATIVE_PDF_SESSIONS_MIGRATION_INPUTS)).sql;

/** The schema sandbox B runs now, with rows in the tables its alpha has written: a case, a grant, finalized and pending uploads, a render run. */
function deployed() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
  db.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
  migrate(db, assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
  db.exec(`INSERT INTO rs_storage_identity (singleton, client_id, layout) VALUES (1, 'client-b', 'clearcase.rs/1')`);
  db.exec(`INSERT INTO rs_case (case_id) VALUES ('case-b')`);
  for (const [op, state] of [['op-final-0000000001', 'finalized'], ['op-stored-000000001', 'stored'], ['op-receiv-000000001', 'received']] as const) {
    db.exec(`INSERT INTO submissions_upload (client_id, case_id, operation_id, asset_id, path, filename, media_type, size, sha256, state, principal_issuer, principal_subject, declared_at)
      VALUES ('client-b', 'case-b', '${op}', 'sub-${op}', 'Letters/${state}.pdf', '${state}.pdf', 'application/pdf', 10, '${SHA(state[0]!)}', 'received', 'iss', 'sub', '${AT}')`);
    if (state !== 'received') db.exec(`UPDATE submissions_upload SET state = 'stored', stored_at = '${AT}' WHERE operation_id = '${op}'`);
  }
  db.exec(`INSERT INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at) VALUES ('client-b', 'case-b', 'subrev-op-final-0000000001', 1, 'op-final-0000000001', 1, '${AT}')`);
  db.exec(`INSERT INTO submissions_file (client_id, case_id, revision_id, path, path_key, filename, media_type, size, sha256, asset_id)
    SELECT client_id, case_id, 'subrev-op-final-0000000001', path, lower(path), filename, media_type, size, sha256, asset_id FROM submissions_upload WHERE operation_id = 'op-final-0000000001'`);
  db.exec(`UPDATE submissions_upload SET state = 'finalized' WHERE operation_id = 'op-final-0000000001'`);
  return db;
}
type Snapshot = ReturnType<typeof snapshot>;
function snapshot(db: DatabaseSync) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as { name: string; sql: string }[];
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' ORDER BY name").all() as { name: string; sql: string | null }[];
  const rows = (name: string) => db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Record<string, unknown>[];
  return { tables: tables.map((t) => ({ ...t, rows: rows(t.name) })), triggers, indexes };
}
const names = (xs: readonly { name: string }[]) => xs.map((x) => x.name);
const added = <T extends { name: string }>(after: readonly T[], before: readonly T[]) => names(after).filter((n) => !names(before).includes(n));
const byName = (s: Snapshot, name: string) => s.tables.find((t) => t.name === name)!;
// 0007 rebuilds submissions_revision by copy-back and replaces exactly these triggers (its own test pins why); nothing else of 0001-0006 changes.
const REBUILT = 'submissions_revision';
const REPLACED = ['submissions_revision_insert_once', 'submissions_file_insert_once', 'submissions_file_matches_declaration', 'submissions_upload_needs_revision'];
const sortRows = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

describe('0008 scaled PDF evidence sessions increment', () => {
  it('upgrades the schema B runs now, holding rows, through 0005, 0006, 0007 and 0008: every earlier table, row, trigger and index survives', () => {
    const db = deployed(), before = snapshot(db);
    for (const sql of LATER) migrate(db, sql());
    const mid = snapshot(db);
    migrate(db, SQL());
    const after = snapshot(db);

    // Every table B has now keeps its definition and its rows; the one 0007 rebuilds keeps its rows exactly.
    for (const t of before.tables) {
      const now = byName(after, t.name);
      if (t.name === REBUILT) { expect(sortRows(now.rows)).toEqual(sortRows(t.rows)); continue; }
      expect(now).toEqual(t);
    }
    expect(after.triggers.filter((t) => names(before.triggers).includes(t.name) && !REPLACED.includes(t.name)))
      .toEqual(before.triggers.filter((t) => !REPLACED.includes(t.name)));
    expect(after.indexes.filter((i) => names(before.indexes).includes(i.name))).toEqual(before.indexes);
    // 0008 adds only the session admission tables, its index and its seals, and changes nothing 0005 to 0007 made.
    expect(after.tables.filter((t) => names(mid.tables).includes(t.name))).toEqual(mid.tables);
    expect(after.triggers.filter((t) => names(mid.triggers).includes(t.name))).toEqual(mid.triggers);
    expect(added(after.tables, mid.tables)).toEqual(['npr_pdf_session_days', 'npr_pdf_sessions']);
    expect(added(after.indexes, mid.indexes)).toContain('npr_pdf_session_day');
    expect(added(after.triggers, mid.triggers).length).toBeGreaterThan(0);
    // What the evidence build and the scaled PDF checker need is there after the whole chain.
    for (const table of ['pub_evidence_run', 'pub_evidence_item', 'pub_evidence_page', 'pub_signoff_evidence', 'npr_content_receipts', 'native_import_stage_run', 'submissions_set', 'npr_pdf_sessions'])
      expect(names(after.tables)).toContain(table);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    db.close();
  });

  it('gives the same schema as a fresh database that takes the whole chain', () => {
    const upgraded = deployed();
    for (const sql of LATER) migrate(upgraded, sql());
    migrate(upgraded, SQL());
    const fresh = new DatabaseSync(':memory:');
    fresh.exec('PRAGMA foreign_keys=ON');
    fresh.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
    fresh.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
    migrate(fresh, assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
    for (const sql of LATER) migrate(fresh, sql());
    migrate(fresh, SQL());
    const shape = (s: Snapshot) => ({ tables: s.tables.map(({ name, sql }) => ({ name, sql })), triggers: s.triggers, indexes: s.indexes });
    expect(shape(snapshot(upgraded))).toEqual(shape(snapshot(fresh)));
    upgraded.close(); fresh.close();
  });

  it('is additive, rolls back whole on a failure, and refuses a replay', () => {
    expect(SQL()).not.toMatch(/\b(ALTER|DROP)\s+TABLE\b/i);
    const db = deployed();
    for (const sql of LATER) migrate(db, sql());
    const before = snapshot(db);
    expect(() => migrate(db, `${SQL()}\nINSERT INTO absent_synthetic_table VALUES (1);`)).toThrow();
    expect(snapshot(db)).toEqual(before);
    migrate(db, SQL());
    const applied = snapshot(db);
    expect(() => migrate(db, SQL())).toThrow();
    expect(snapshot(db)).toEqual(applied);
    db.close();
  });

  it('depends on the 0007 the file-sets packet emits, pins its input, and stages a distinct, tamper-evident 0008 packet, also through the CLI', () => {
    expect(NATIVE_PDF_SESSIONS_APPLIED_INTAKE_FILE_SETS).toEqual(assembleNativeIntakeFileSetsMigration(sources(NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS)).manifest.output);
    const inputs = sources(NATIVE_PDF_SESSIONS_MIGRATION_INPUTS), plan = assembleNativePdfSessionsMigration(inputs);
    expect(plan.manifest.output.path).toBe('migrations/0008_native_pdf_sessions.sql');
    expect(inputs.map((i) => i.path)).toEqual(['src/lib/viewer/hosted/migrations/0004_pdf_evidence_sessions.sql']);
    inputs[0]!.bytes[0] ^= 1;
    expect(() => assembleNativePdfSessionsMigration(inputs)).toThrow();
    const root = process.cwd(), dir = mkdtempSync(path.join(tmpdir(), 'cc-pdf-sessions-'));
    try {
      const staged = prepareNativePdfSessionsMigration({ root, out: path.join(dir, 'stage') });
      expect(staged.mode).toBe(NATIVE_PDF_SESSIONS_MIGRATION_MODE);
      expect(readNativePdfSessionsMigration({ root, stage: staged.stage }).sql).toBe(plan.sql);
      for (const target of staged.manifest.targets) {
        expect(checkNativePdfSessionsMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: target.argv }).target).toEqual(target);
        expect(() => checkNativePdfSessionsMigrationInvocation({ root, stage: staged.stage, cwd: staged.stage, slot: target.slot, argv: [...target.argv, '--local'] })).toThrow();
      }
      const cli = (...args: string[]) => spawnSync(process.execPath, ['scripts/hosted-native-runtime-migration.ts', ...args], { cwd: root, encoding: 'utf8' });
      const viaCli = path.join(dir, 'cli-stage');
      expect(cli('prepare', viaCli, NATIVE_PDF_SESSIONS_MIGRATION_MODE).status).toBe(0);
      expect(cli('verify', viaCli, NATIVE_PDF_SESSIONS_MIGRATION_MODE).status).toBe(0);
      expect(readFileSync(path.join(viaCli, plan.manifest.output.path), 'utf8')).toBe(plan.sql);
      expect(cli('verify', viaCli, 'no-such-increment').status).toBe(2);
      // A stage of one increment never verifies as another.
      expect(cli('verify', viaCli).status).toBe(1);
      writeFileSync(path.join(staged.stage, plan.manifest.output.path), 'tampered');
      expect(() => readNativePdfSessionsMigration({ root, stage: staged.stage })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it('0009 original metadata is a separate pinned native increment, preserving existing originals and the earlier schema', () => {
 const db = deployed();
 for (const sql of LATER) migrate(db, sql());
 migrate(db, SQL());
 db.exec(`INSERT INTO rs_original (sha256,size,object_key) VALUES ('${SHA('a')}',4,'orig/${SHA('a')}')`);
 const before = snapshot(db), root = process.cwd(), dir = mkdtempSync(path.join(tmpdir(), 'cc-original-metadata-'));
 const cli = (...args: string[]) => spawnSync(process.execPath, ['scripts/hosted-native-runtime-migration.ts', ...args], { cwd: root, encoding: 'utf8' });
 try {
  const stage = path.join(dir, 'stage'), prepared = cli('prepare', stage, 'original-metadata-0009');
  expect(prepared.status, prepared.stderr).toBe(0);
  const packet = JSON.parse(prepared.stdout);
  expect(packet.output.path).toBe('migrations/0009_rs_original_etag.sql');
  expect(packet.appliedPdfSessionsDependency).toEqual(assembleNativePdfSessionsMigration(sources(NATIVE_PDF_SESSIONS_MIGRATION_INPUTS)).manifest.output);
  expect(packet.inputs.map((p: { path: string }) => p.path)).toEqual(['src/lib/storage/cloud/migrations/0003_rs_original_etag.sql']);
  expect(cli('verify', stage, 'original-metadata-0009').status).toBe(0);
  migrate(db, readFileSync(path.join(stage, packet.output.path), 'utf8'));
  const after = snapshot(db);
  expect(after.tables.filter(t => t.name !== 'rs_original')).toEqual(before.tables.filter(t => t.name !== 'rs_original'));
  expect(after.triggers).toEqual(before.triggers); expect(after.indexes).toEqual(before.indexes);
  expect(db.prepare('SELECT sha256,size,object_key,etag,media_family FROM rs_original').all()).toEqual([
   { sha256: SHA('a'), size: 4, object_key: `orig/${SHA('a')}`, etag: null, media_family: null },
  ]);
  db.prepare("INSERT INTO rs_original (sha256,size,object_key,etag,media_family) VALUES (?,4,?,'verified-etag','pdf')").run(SHA('b'), `orig/${SHA('b')}`);
  expect(db.prepare('SELECT etag,media_family FROM rs_original WHERE sha256=?').get(SHA('b'))).toEqual({ etag: 'verified-etag', media_family: 'pdf' });
  const applied = snapshot(db);
  expect(() => migrate(db, readFileSync(path.join(stage, packet.output.path), 'utf8'))).toThrow();
  expect(snapshot(db)).toEqual(applied);
  writeFileSync(path.join(stage, packet.output.path), 'tampered');
  expect(cli('verify', stage, 'original-metadata-0009').status).toBe(1);
 } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
