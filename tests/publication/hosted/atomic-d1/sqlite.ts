// SQL-engine tests only: real file-backed SQLite, real schemas, D1-shaped transport. NOT Cloudflare D1 evidence.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { PublicationD1, PublicationD1Statement, PublicationD1Value } from '../../../../src/lib/publication/hosted/ledger.ts';
import type { PublicationD1Database } from '../../../../src/lib/publication/hosted/d1-publisher.ts';

type Executable = PublicationD1Statement & { exec(): { results: unknown[] } };
export class FileD1 implements PublicationD1Database, PublicationD1 {
  readonly sqlite: DatabaseSync;
  beforeBatch: (() => void | Promise<void>) | null = null;
  afterStatement: ((index: number) => void) | null = null;
  loseAcknowledgement = false;
  failReads = false;
  failSql: RegExp | null = null;
  sessions: string[] = [];
  readonly path: string;
  constructor(path: string, migrate = false) {
    this.path = path;
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000');
    if (migrate) for (const path of [
      'src/lib/storage/cloud/migrations/0001_rs_results_storage.sql',
      'src/lib/tenancy/migrations/0001_tenant_case_grants.sql',
      'src/lib/tenancy/migrations/0002_tenant_grant_operations.sql',
      'tests/publication/hosted/atomic-d1/fixtures/0001_native_candidate_import.ebe3ed4b.sql',
      'src/lib/publication/hosted/migrations/0001_publication_ledger.sql',
      'src/lib/publication/hosted/migrations/0002_atomic_publication.sql',
    ]) this.sqlite.exec(readFileSync(path, 'utf8'));
  }
  withSession(constraint: 'first-primary'): PublicationD1 { this.sessions.push(constraint); return this; }
  prepare(sql: string): Executable {
    const make = (values: PublicationD1Value[]): Executable => ({
      bind: (...v) => make(v),
      exec: () => {
        if (this.failSql?.test(sql)) { this.failSql = null; throw new Error('injected SQL failure'); }
        if (this.failReads && /^\s*SELECT/i.test(sql)) throw new Error('injected lost readback');
        const q = this.sqlite.prepare(sql);
        if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: q.all(...values) };
        q.run(...values); return { results: [] };
      },
      first: async <T>() => (make(values).exec().results[0] ?? null) as T | null,
      all: async <T>() => ({ results: make(values).exec().results as T[] }),
      run: async () => make(values).exec(),
    });
    return make([]);
  }
  async batch(statements: PublicationD1Statement[]): Promise<unknown[]> {
    const hook = this.beforeBatch; this.beforeBatch = null; await hook?.();
    this.sqlite.exec('BEGIN IMMEDIATE');
    let result: unknown[];
    try {
      result = statements.map((s, i) => { const r = (s as Executable).exec(); this.afterStatement?.(i); return r; });
      this.sqlite.exec('COMMIT');
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    if (this.loseAcknowledgement) { this.loseAcknowledgement = false; this.failReads = true; throw new Error('lost commit acknowledgement'); }
    return result;
  }
  exec(sql: string, ...values: PublicationD1Value[]) { this.sqlite.prepare(sql).run(...values); }
  rows<T = Record<string, unknown>>(sql: string, ...values: PublicationD1Value[]): T[] { return this.sqlite.prepare(sql).all(...values) as T[]; }
  close() { this.sqlite.close(); }
}
