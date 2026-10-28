// The shard manifest (04's PayloadManifest): canonical JSON, shards sorted by name. Its own sha256 is what a sign-off
// binds and what `publish` compares with the copy stored in R2.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/lib/case-package/canonical.ts';
import { SHARD_MANIFEST_FORMAT, type PayloadManifest } from '../../src/lib/views/payloads/manifest.ts';
import type { Shard } from './types.ts';

export const MANIFEST_NAME = 'manifest.json';
export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function shardManifest(a: Omit<PayloadManifest, 'format' | 'shards'>, shards: readonly Shard[]): { manifest: PayloadManifest; bytes: Uint8Array; sha256: string } {
  const entries = shards.map((s) => ({ name: s.name, bytes: s.bytes.byteLength, sha256: sha256Hex(s.bytes) })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const manifest: PayloadManifest = { format: SHARD_MANIFEST_FORMAT, ...a, shards: entries };
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  return { manifest, bytes, sha256: sha256Hex(bytes) };
}
