// `upload`: the shards to `<remote>/views/<rvHex>/` with rclone, immutable, the manifest last, then `rclone check`.
import { execFileSync } from 'node:child_process';
import { shardPrefix, SHARD_CACHE_CONTROL } from '../../src/lib/results/hosted/shards.ts';
import { MANIFEST_NAME } from './manifest.ts';

const rclone = (args: string[]) => execFileSync('rclone', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
const remotePrefix = (remote: string, rv: string) => `${remote.replace(/\/+$/, '')}/${shardPrefix(rv)}`;

export function upload(a: { dir: string; remote: string; resultsVersion: string }): void {
  const to = remotePrefix(a.remote, a.resultsVersion);
  const headers = ['--header-upload', `Cache-Control: ${SHARD_CACHE_CONTROL}`, '--header-upload', 'Content-Type: application/json'];
  rclone(['copy', a.dir, to, '--exclude', `/${MANIFEST_NAME}`, '--checksum', ...headers]);
  rclone(['copyto', `${a.dir}/${MANIFEST_NAME}`, `${to}${MANIFEST_NAME}`, '--checksum', ...headers]);
  rclone(['check', a.dir, to, '--one-way']);
}

/** The manifest R2 holds for a version, or null. */
export function remoteManifest(a: { remote: string; resultsVersion: string }): Uint8Array | null {
  try { return new Uint8Array(execFileSync('rclone', ['cat', `${remotePrefix(a.remote, a.resultsVersion)}${MANIFEST_NAME}`], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return null; }
}
