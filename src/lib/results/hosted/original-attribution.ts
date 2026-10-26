import type { LoadedModel } from './model.ts';
import type { OriginalAttribution } from './published-reads.ts';
import type { FolderOriginal } from '../../storage/cloud/original-facts.ts';
import { originalKey } from '../../storage/cloud/keys.ts';

/** Resolve only imported file rows whose immutable verified mapping agrees with a finalized original. real_path is the
 * already resolved literal/NFC path recorded at import, not the association's basename or a newly guessed folded path.
 * Several package aliases may map to one original. New revisions at that path cannot redirect the old fingerprint.
 * Providers, embedded members and missing/unmapped rows remain unlinked. Actual delivery still verifies all bytes. */
export function resolveOriginalAttributions(model: LoadedModel, folder: readonly FolderOriginal[]): OriginalAttribution[] {
  const assets = new Map(model.assets.map((a) => [a.key, a]));
  const byPath = new Map<string, FolderOriginal[]>();
  for (const o of folder) {
    const rows = byPath.get(o.path) ?? [];
    rows.push(o); byPath.set(o.path, rows);
  }
  const out: OriginalAttribution[] = [];
  for (const d of model.docs) {
    const a = assets.get(d.ref);
    if (!a || a.kind !== 'file' || (a.status !== 'verified' && a.status !== 'case-mismatch') || !a.real_path || !a.sha256 || a.size === null) continue;
    const state = JSON.parse(d.state_json) as { file: string; original?: { path: string; sha256: string; size: number } | null };
    const original = state.original;
    if (state.file !== 'present' || !original || original.path !== a.real_path || original.sha256 !== a.sha256 || original.size !== a.size) continue;
    const matches = (byPath.get(a.real_path) ?? []).filter((o) =>
      (o.source === 'submission' || o.assetId === a.key) && o.sha256 === a.sha256 && o.size === a.size && o.originalSize === o.size && o.objectKey === originalKey(o.sha256));
    // All matches have the exact same recorded path and bytes. Select a deterministic actual asset, never create aliases.
    matches.sort((x, y) => x.assetId < y.assetId ? -1 : x.assetId > y.assetId ? 1 : 0);
    if (matches[0]) out.push({ ref: d.ref, assetId: matches[0].assetId });
  }
  return out;
}
