// How the CLI reaches a deployment's D1: `wrangler d1 execute --remote` against the database its wrangler configuration
// names. Tests pass a SQLite double with the same two calls.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CloudD1, CloudD1Statement, D1Value } from '../../src/lib/storage/cloud/bindings.ts';

const WRANGLER = path.resolve(import.meta.dirname, '../../node_modules/wrangler/bin/wrangler.js');

export interface D1Exec {
  /** Runs a file of statements. */
  file(sql: string): Promise<void>;
  /** One query's rows. */
  all<T>(sql: string): Promise<T[]>;
}

/** The first D1 database a wrangler configuration names. */
export function databaseName(config: string): string {
  const m = /"database_name"\s*:\s*"([^"]+)"/.exec(readFileSync(config, 'utf8'));
  if (!m) throw new Error(`${config} names no D1 database`);
  return m[1]!;
}

export function wranglerD1(config: string): D1Exec {
  const db = databaseName(config);
  // Wrangler under Node, as deploy/staging/clerk.ts runs it.
  const wrangler = (args: string[]) => execFileSync('node', [WRANGLER, 'd1', 'execute', db, '--remote', '--config', config, ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } });
  return {
    async file(sql) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-publish-'));
      try {
        const f = path.join(dir, 'batch.sql');
        await writeFile(f, sql, { mode: 0o600 });
        wrangler(['--file', f, '--yes']);
      } finally { await rm(dir, { recursive: true, force: true }); }
    },
    async all<T>(sql: string) {
      const out = JSON.parse(wrangler(['--command', sql, '--json'])) as { results: T[] }[];
      return out.flatMap((r) => r.results);
    },
  };
}

const literal = (v: D1Value) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

/**
 * The hosted reader's read-only D1 shape over `d1`, so `register` can verify what D1 holds with the reader's own
 * loadVerifiedModel: each bound `?` is written into the query as a quoted literal. Reads only; `run` and `batch` refuse.
 */
export function d1Reader(d1: D1Exec): CloudD1 {
  const statement = (sql: string, values: D1Value[]): CloudD1Statement => {
    const text = () => { let i = 0; return sql.replace(/\?/g, () => { if (i >= values.length) throw new Error('a query has more ? than bound values'); return literal(values[i++]!); }); };
    return {
      bind: (...v) => statement(sql, v),
      async first<T>() { return ((await d1.all<T>(text()))[0] ?? null) as T | null; },
      async all<T>() { return { results: await d1.all<T>(text()) }; },
      run: () => Promise.reject(new Error('d1Reader reads only')),
    };
  };
  return { prepare: (sql) => statement(sql, []), batch: () => Promise.reject(new Error('d1Reader reads only')) };
}
