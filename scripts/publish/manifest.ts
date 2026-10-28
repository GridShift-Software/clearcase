// The shard manifest (04's PayloadManifest) and its amendments: canonical JSON, shards sorted by name. A manifest's or an
// amendment's own sha256 is what a sign-off binds and what `publish` compares with the copy stored in R2.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/lib/case-package/canonical.ts';
import { SHARD_MANIFEST_FORMAT, type PayloadManifest, type ShardEntry } from '../../src/lib/views/payloads/manifest.ts';
import type { Shard, ShardAmendment } from './types.ts';

export const MANIFEST_NAME = 'manifest.json';
export const AMENDMENT_FORMAT = 'clearcase.shard-amendment/1';
/** Where an amendment lives under the version's prefix: content-addressed, so it is never replaced. */
export const amendmentName = (sha256: string) => `amendments/${sha256}.json`;
export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const entries = (shards: readonly Shard[]): ShardEntry[] =>
  shards.map((s) => ({ name: s.name, bytes: s.bytes.byteLength, sha256: sha256Hex(s.bytes) })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
const encoded = <T>(value: T) => { const bytes = new TextEncoder().encode(canonicalJson(value)); return { bytes, sha256: sha256Hex(bytes) }; };

export function shardManifest(a: Omit<PayloadManifest, 'format' | 'shards'>, shards: readonly Shard[]): { manifest: PayloadManifest; bytes: Uint8Array; sha256: string } {
  const manifest: PayloadManifest = { format: SHARD_MANIFEST_FORMAT, ...a, shards: entries(shards) };
  return { manifest, ...encoded(manifest) };
}

export function shardAmendment(a: Omit<ShardAmendment, 'format' | 'shards'>, shards: readonly Shard[]): { amendment: ShardAmendment; bytes: Uint8Array; sha256: string; name: string } {
  const amendment: ShardAmendment = { format: AMENDMENT_FORMAT, ...a, shards: entries(shards) };
  const e = encoded(amendment);
  return { amendment, ...e, name: amendmentName(e.sha256) };
}

/** A manifest.json or an amendment file as `upload`, `amend` and `publish` read it: what it is, for which version, and what it lists. */
export interface ShardIndex { kind: 'manifest' | 'amendment'; name: string; sha256: string; caseId: string; resultsVersion: string; shards: readonly ShardEntry[]; amendment: ShardAmendment | null }

export function readIndex(name: string, bytes: Uint8Array): ShardIndex {
  let v: { format?: unknown; caseId?: unknown; resultsVersion?: unknown; shards?: unknown };
  try { v = JSON.parse(new TextDecoder().decode(bytes)) as typeof v; } catch { throw new Error(`${name} is not JSON`); }
  const kind = name === MANIFEST_NAME ? 'manifest' : 'amendment';
  if (v.format !== (kind === 'manifest' ? SHARD_MANIFEST_FORMAT : AMENDMENT_FORMAT) || typeof v.caseId !== 'string' || typeof v.resultsVersion !== 'string' || !Array.isArray(v.shards))
    throw new Error(`${name} is not a shard ${kind}`);
  const sha256 = sha256Hex(bytes);
  if (kind === 'amendment' && name !== amendmentName(sha256)) throw new Error(`${name} is not named by its own sha256`);
  if (new TextDecoder().decode(bytes) !== canonicalJson(v)) throw new Error(`${name} is not canonical JSON`);
  return { kind, name, sha256, caseId: v.caseId, resultsVersion: v.resultsVersion, shards: v.shards as ShardEntry[], amendment: kind === 'amendment' ? (v as ShardAmendment) : null };
}
