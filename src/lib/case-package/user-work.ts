
export interface DocumentAnchor {
  caseId: string;
  sha256: string;
  refAtCreation: string;
  resultsVersion: string;
}

export interface AnchorCandidate { ref: string; sha256: string }

export type AnchorMatch =
  | { status: 'exact'; ref: string }
  | { status: 'ambiguous'; refs: string[] }
  | { status: 'missing' };

export function matchAnchor(anchor: DocumentAnchor, originals: Iterable<AnchorCandidate>): AnchorMatch {
  const refs = [...originals].filter((o) => o.sha256 === anchor.sha256).map((o) => o.ref).sort();
  if (refs.length === 0) return { status: 'missing' };
  if (refs.length === 1) return { status: 'exact', ref: refs[0]! };
  return { status: 'ambiguous', refs };
}

export interface SeedRow {
  datasetKey: string;
  seedId: string;
  seedSha256: string;
  record: Readonly<Record<string, unknown>>;
}

export interface SeedOverlay {
  caseId: string;
  datasetKey: string;
  seedId: string;
  baseSeedSha256: string;
  fields: Record<string, unknown>;
}

export type SeedView =
  | { state: 'seed'; seed: SeedRow }
  | { state: 'edited'; seed: SeedRow; overlay: SeedOverlay }
  | { state: 'conflict'; seed: SeedRow; overlay: SeedOverlay }
  | { state: 'orphaned'; overlay: SeedOverlay };

export function viewSeeds(seeds: readonly SeedRow[], overlays: readonly SeedOverlay[]): SeedView[] {
  const byId = new Map(overlays.map((o) => [`${o.datasetKey}\u0000${o.seedId}`, o]));
  const out: SeedView[] = seeds.map((s) => {
    const o = byId.get(`${s.datasetKey}\u0000${s.seedId}`);
    byId.delete(`${s.datasetKey}\u0000${s.seedId}`);
    if (!o) return { state: 'seed', seed: s };
    return o.baseSeedSha256 === s.seedSha256 ? { state: 'edited', seed: s, overlay: o } : { state: 'conflict', seed: s, overlay: o };
  });
  for (const o of byId.values()) out.push({ state: 'orphaned', overlay: o });
  return out;
}
