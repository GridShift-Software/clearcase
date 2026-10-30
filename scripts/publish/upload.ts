// `upload`: one manifest.json or amendment and the shards it lists, to `<remote>/views/<rvHex>/`, immutable. The local
// files are checked against the bytes and sha256 the list names first; then every object R2 already holds is compared
// byte for byte, and any that differs refuses the whole upload before anything is written. Only absent objects are
// created (never replaced), the list last, then `rclone check`.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shardPrefix, SHARD_CACHE_CONTROL } from '../../src/lib/results/hosted/shards.ts';
import { readIndex, sha256Hex } from './manifest.ts';

export type RemoteState = 'same' | 'differs' | 'absent';

/** A version's prefix in the client bucket, by object name under it. */
export interface ShardRemote {
  /** Whether the remote holds each of `names` with exactly the bytes of `<dir>/<name>`, other bytes, or not at all. */
  compare(dir: string, names: readonly string[]): Promise<Map<string, RemoteState>>;
  /** Writes `<dir>/<name>` for each of `names` the remote lacks. Never replaces an object. */
  create(dir: string, names: readonly string[]): Promise<void>;
  read(name: string): Promise<Uint8Array | null>;
}

/**
 * Uploads `<dir>/<index>` (`manifest.json` or `amendments/<sha256>.json`) and the shards it lists. Returns the names it
 * created; a repeat creates nothing.
 */
export async function upload(a: { dir: string; index: string; remote: ShardRemote }): Promise<{ created: string[] }> {
  const ix = readIndex(a.index, new Uint8Array(await readFile(path.join(a.dir, a.index))));
  for (const s of ix.shards) {
    const bytes = await readFile(path.join(a.dir, s.name)).catch(() => null);
    if (!bytes || bytes.byteLength !== s.bytes || sha256Hex(bytes) !== s.sha256) throw new Error(`${s.name} is not the file ${a.index} lists: build again`);
  }
  const shards = ix.shards.map((s) => s.name), names = [...shards, a.index];
  const before = await a.remote.compare(a.dir, names);
  const changed = names.filter((n) => before.get(n) === 'differs');
  if (changed.length) throw new Error(`upload refused, nothing written: R2 already holds other bytes for ${changed.join(', ')}. A published object is never replaced: add a family with build --family (docs/sprint/runbooks/06-publish.md), or publish a new version.`);
  const absent = (n: string) => before.get(n) !== 'same';
  const created = [...shards.filter(absent), ...(absent(a.index) ? [a.index] : [])];
  await a.remote.create(a.dir, created.filter((n) => n !== a.index));
  if (absent(a.index)) await a.remote.create(a.dir, [a.index]);
  const after = await a.remote.compare(a.dir, names);
  const wrong = names.filter((n) => after.get(n) !== 'same');
  if (wrong.length) throw new Error(`after upload R2 does not hold these as built: ${wrong.join(', ')}`);
  return { created };
}

const rclone = (args: string[]) => execFileSync('rclone', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

/** `rclone` over `<remote>/views/<rvHex>/`: compared by downloading (`check --download`), created with `copy --ignore-existing`. */
export function rcloneRemote(a: { remote: string; resultsVersion: string }): ShardRemote {
  const to = `${a.remote.replace(/\/+$/, '')}/${shardPrefix(a.resultsVersion)}`;
  const withList = async <T>(names: readonly string[], run: (list: string) => T): Promise<T> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-upload-'));
    try { const list = path.join(dir, 'files'); await writeFile(list, names.map((n) => `${n}\n`).join('')); return run(list); }
    finally { await rm(dir, { recursive: true, force: true }); }
  };
  return {
    compare: (dir, names) => withList(names, (list) => {
      // --combined: `= name` identical, `+ name` absent from R2, `- name` absent locally, `* name` differs, `! name` unreadable.
      const r = spawnSync('rclone', ['check', dir, to, '--one-way', '--download', '--files-from', list, '--combined', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const out = new Map<string, RemoteState>();
      for (const line of r.stdout.split('\n')) {
        const m = /^([=*!+-]) (.+)$/.exec(line);
        if (!m) continue;
        if (m[1] === '!') throw new Error(`rclone could not compare ${m[2]}: ${r.stderr.trim().split('\n').pop() ?? ''}`);
        if (m[1] === '-') throw new Error(`rclone source file missing: ${m[2]}`);
        out.set(m[2]!, m[1] === '=' ? 'same' : m[1] === '*' ? 'differs' : 'absent');
      }
      const missing = names.filter((n) => !out.has(n));
      if (r.status !== 0 && r.status !== 1 || missing.length) throw new Error(`rclone check failed (exit ${r.status}): ${missing.length ? `no answer for ${missing.join(', ')}` : r.stderr.trim()}`);
      return out;
    }),
    create: (dir, names) => withList(names, (list) => {
      if (!names.length) return;
      rclone(['copy', dir, to, '--files-from', list, '--ignore-existing', '--no-update-modtime',
        '--header-upload', `Cache-Control: ${SHARD_CACHE_CONTROL}`, '--header-upload', 'Content-Type: application/json']);
    }),
    async read(name) {
      try { return new Uint8Array(execFileSync('rclone', ['cat', `${to}${name}`], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
      catch { return null; }
    },
  };
}
