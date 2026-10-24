// UNIT TEST DOUBLES ONLY. A D1 stand-in over node:sqlite (as the local case store uses it) and an in-memory R2 stand-in, so the storage adapters' SQL
// and integrity logic run against the real migration. They are not Cloudflare's D1 or R2: nothing here is evidence of
// remote behaviour, limits or latency, and no production path can reach them.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CloudD1, CloudD1Statement, CloudR2, CloudR2Body, CloudR2Head, D1Value } from '../../../src/lib/storage/cloud/bindings.ts';

const MIGRATION = path.join(import.meta.dirname, '../../../src/lib/storage/cloud/migrations/0001_rs_results_storage.sql');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export class SqliteD1 implements CloudD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  statements = 0;
  failNext: RegExp | null = null;
  constructor() {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec(readFileSync(MIGRATION, 'utf8'));
  }
  prepare(sql: string): CloudD1Statement {
    const db = this;
    const make = (values: D1Value[]): CloudD1Statement & { exec(): unknown } => ({
      bind: (...v) => make(v),
      exec() {
        db.statements++;
        if (db.failNext?.test(sql)) { db.failNext = null; throw new Error('D1_ERROR: injected failure'); }
        const q = db.sqlite.prepare(sql);
        return /^\s*(SELECT|WITH)/i.test(sql) ? q.all(...values) : (q.run(...values), []);
      },
      async first<T>() { return ((this.exec() as T[])[0] ?? null) as T | null; },
      async all<T>() { return { results: this.exec() as T[] }; },
      async run() { return this.exec(); },
    });
    return make([]);
  }
  async batch(statements: CloudD1Statement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => (s as unknown as { exec(): unknown }).exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) { this.sqlite.exec('ROLLBACK'); throw e; }
  }
  exec(sql: string, ...values: D1Value[]) { this.sqlite.prepare(sql).run(...values); }
  rows<T>(sql: string, ...values: D1Value[]) { return this.sqlite.prepare(sql).all(...values) as T[]; }
}

interface Stored { bytes: Uint8Array; sha256: string | null; version: number }
export class MemoryR2 implements CloudR2 {
  readonly objects = new Map<string, Stored>();
  private seq = 0;
  gets = 0;
  private head_(key: string, o: Stored): CloudR2Head {
    const checksums: { sha256?: ArrayBuffer } = {};
    if (o.sha256) checksums.sha256 = new Uint8Array(Buffer.from(o.sha256, 'hex')).buffer;
    return { key, size: o.bytes.byteLength, etag: `e${o.version}`, version: `v${o.version}`, checksums };
  }
  async head(key: string) { const o = this.objects.get(key); return o ? this.head_(key, o) : null; }
  async get(key: string): Promise<CloudR2Body | null> {
    this.gets++;
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = new Uint8Array(o.bytes);
    return { ...this.head_(key, o), arrayBuffer: async () => bytes.buffer };
  }
  async put(key: string, value: Uint8Array, options: { sha256: string }) {
    if (sha(value) !== options.sha256) throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
    const o = { bytes: new Uint8Array(value), sha256: options.sha256, version: ++this.seq };
    this.objects.set(key, o);
    return this.head_(key, o);
  }
  /** A credential holder's change at rest: other bytes under the key, with no checksum update. */
  tamper(key: string, edit: (b: Uint8Array) => Uint8Array) {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no object ${key}`);
    this.objects.set(key, { bytes: edit(new Uint8Array(o.bytes)), sha256: o.sha256, version: ++this.seq });
  }
  setRaw(key: string, bytes: Uint8Array) { this.objects.set(key, { bytes, sha256: null, version: ++this.seq }); }
}
