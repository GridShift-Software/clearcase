import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../../../deploy/native-alpha/schema.ts';
import { assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS, assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS } from '../../../../../deploy/native-alpha/runtime-migration.ts';
import { createEvidenceEngine, d1EvidenceStore } from './index.ts';

const sources = (pins: readonly { path: string }[]) => pins.map(p => ({ path: p.path, bytes: readFileSync(p.path) }));
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
  db.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
  db.exec(assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
  db.exec(assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql);
  return db;
}
// Adapter preserves D1 batch atomicity while executing actual SQLite statements.
function d1(db: DatabaseSync) {
  function prepare(sql: string) {
    let values: (string | number | null)[] = [];
    const statement = {
      bind(...v: (string | number | null)[]) { values = v; return statement; },
      async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...values) as T[] }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
    };
    return statement;
  }
  return { withSession: (_: 'first-primary') => ({ prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } }) };
}
const binding = { candidateId: 'candidate', generation: 'generation', clientId: 'client', caseId: 'case', resultsVersion: 'version', manifestSha256: 'a'.repeat(64), validatorVersion: 'validator', rendererVersion: 'renderer' };
function producer(changed = false) {
  return async (cursor: string | null) => {
    const n = cursor === null ? 0 : Number(cursor);
    if (n === 3000) return { done: true as const };
    return { done: false as const, nextCursor: String(n + 1), key: String(n).padStart(6, '0'), observation: { kind: 'section', value: changed && n === 1777 ? 'changed' : `item ${n}`, assetSha256: 'b'.repeat(64), assetSize: n } };
  };
}
function setup(changed = false) {
  const db = database(); let now = 0;
  const store = d1EvidenceStore(d1(db));
  const engine = (leaseId: string) => createEvidenceEngine({ binding, store, producer: producer(changed), clock: () => now, leaseId, leaseMs: 100, bounds: { itemsPerStep: 20, bytesHashedPerStep: 65536 } });
  return { db, engine, advance: (ms: number) => { now += ms; } };
}
async function finish(engine: ReturnType<ReturnType<typeof setup>['engine']>, interruptAt = -1, onInterrupt = () => {}) {
  for (let step = 0; step < 10000; step++) {
    if (step === interruptAt) onInterrupt();
    const result = await engine.step();
    if (result.kind === 'complete') return result.root;
    expect(result.kind).toBe('progress');
  }
  throw new Error('build did not finish');
}

describe('resumable evidence build on migrated SQLite', () => {
  it('resumes 3,000 observations after seeded interruptions and binds every item to the root', async () => {
    const baseline = setup();
    const root = await finish(baseline.engine('original'));
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    baseline.db.close();
    for (const seed of [1, 29, 1009, 65537]) {
      const run = setup();
      let engine = run.engine('before');
      const interruptAt = 1 + ((seed * 1103515245 + 12345) >>> 0) % 140;
      const resumed = await finish({ step: () => engine.step() }, interruptAt, () => { run.advance(101); engine = run.engine('after'); });
      expect(resumed).toBe(root);
      run.db.close();
    }
    const changed = setup(true);
    expect(await finish(changed.engine('changed'))).not.toBe(root);
    changed.db.close();
  });
  it('refuses a concurrent builder and safely transfers an expired lease', async () => {
    const run = setup();
    const first = run.engine('first'), second = run.engine('second');
    expect((await first.step()).kind).toBe('progress');
    const count = run.db.prepare('SELECT count(*) AS n FROM pub_evidence_item').get()?.n;
    expect((await second.step()).kind).toBe('leased');
    expect(run.db.prepare('SELECT count(*) AS n FROM pub_evidence_item').get()?.n).toBe(count);
    run.advance(101);
    expect((await second.step()).kind).toBe('progress');
    expect((await first.step()).kind).toBe('leased');
    expect(await finish(second)).toMatch(/^[0-9a-f]{64}$/);
    run.db.close();
  });
});
