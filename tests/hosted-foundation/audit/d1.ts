// A D1 stand-in for unit tests: node:sqlite behind D1's prepare/bind/first/all/run/batch. It is NOT evidence of D1.
// batch() runs its statements inside one SQLite transaction, as D1 documents for batch; each run() autocommits.
import { DatabaseSync } from 'node:sqlite';
import type { D1, D1Statement } from '../../../src/lib/server/runtime/hosted/bindings.ts';

export type Fault = { failInsertAfterCommit?: boolean; failInsert?: boolean; failAll?: boolean };
export function d1(db: DatabaseSync, fault: Fault = {}): D1 {
  const statement = (sql: string, values: (string | number | null)[] = []): D1Statement => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => { if (fault.failAll) throw new Error('D1_ERROR: unavailable'); return (db.prepare(sql).get(...values) as T | undefined) ?? null; },
    all: async <T>() => { if (fault.failAll) throw new Error('D1_ERROR: unavailable'); return { results: db.prepare(sql).all(...values) as T[] }; },
    run: async () => {
      if (fault.failAll) throw new Error('D1_ERROR: unavailable');
      if (fault.failInsert && /^\s*INSERT/i.test(sql)) throw new Error('D1_ERROR: storage full');
      const r = db.prepare(sql).run(...values);
      // a lost acknowledgement: the write committed, the caller sees an error
      if (fault.failInsertAfterCommit && /^\s*INSERT/i.test(sql)) throw new Error('D1_ERROR: network connection lost');
      return r;
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (all) => {
      db.exec('BEGIN');
      try { const out = []; for (const s of all) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
