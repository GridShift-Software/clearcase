import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import { assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS, assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS } from '../../../deploy/native-alpha/runtime-migration.ts';
import { createEvidenceEngine, d1EvidenceStore, type EvidenceBinding, type EvidenceBounds, type EvidenceProducer } from '../../../src/lib/publication/hosted/evidence/index.ts';

const sources = (pins: readonly { path: string }[]) => pins.map(p => ({ path: p.path, bytes: readFileSync(p.path) }));
export function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
  db.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
  db.exec(assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql);
  db.exec(assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql);
  return db;
}
type Value = string | number | null;
/** Adapter preserves D1 batch atomicity while executing actual SQLite statements. `hook` runs around every batch, to simulate a crash. */
export function d1(db: DatabaseSync, hook: { before?: () => void; after?: () => void } = {}) {
  function prepare(sql: string) {
    let values: Value[] = [];
    const statement = {
      bind(...v: Value[]) { values = v; return statement; },
      async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...values) as T[] }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
    };
    return statement;
  }
  return { withSession: (_: 'first-primary') => ({ prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    hook.before?.();
    db.exec('BEGIN');
    let results;
    try { results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    hook.after?.();
    return results;
  } }) };
}
export const binding: EvidenceBinding = { candidateId: 'candidate', generation: 'generation', clientId: 'client', caseId: 'case', resultsVersion: 'version', manifestSha256: 'a'.repeat(64), validatorVersion: 'validator', rendererVersion: 'renderer' };
export const TOTAL = 3000;
export function producer(changed = false, total = TOTAL): EvidenceProducer {
  return async (cursor: string | null) => {
    const n = cursor === null ? 0 : Number(cursor);
    if (n === total) return { done: true as const };
    return { done: false as const, nextCursor: String(n + 1), key: String(n).padStart(6, '0'), observation: { kind: 'section', value: changed && n === 1777 ? 'changed' : `item ${n}`, assetSha256: 'b'.repeat(64), assetSize: n } };
  };
}
export const BOUNDS: EvidenceBounds = { itemsPerStep: 20, bytesPerStep: 65536 };
export function setup(options: { changed?: boolean; hook?: { before?: () => void; after?: () => void }; producer?: EvidenceProducer; bounds?: EvidenceBounds; binding?: EvidenceBinding } = {}) {
  const db = database(); let now = 0;
  const store = d1EvidenceStore(d1(db, options.hook));
  const engine = (leaseId: string, overrides: { producer?: EvidenceProducer; binding?: EvidenceBinding } = {}) => createEvidenceEngine({
    binding: overrides.binding ?? options.binding ?? binding, store, producer: overrides.producer ?? options.producer ?? producer(options.changed), clock: () => now, leaseId, leaseMs: 100, bounds: options.bounds ?? BOUNDS });
  return { db, store, engine, now: () => now, advance: (ms: number) => { now += ms; } };
}
type Engine = { step(): Promise<{ kind: string; root?: string }> };
export async function finish(engine: Engine, interruptAt = -1, onInterrupt = () => {}): Promise<string> {
  for (let step = 0; step < 10000; step++) {
    if (step === interruptAt) onInterrupt();
    const result = await engine.step();
    if (result.kind === 'complete') return result.root as string;
    if (result.kind !== 'progress') throw new Error(`unexpected step result ${result.kind}`);
  }
  throw new Error('build did not finish');
}
