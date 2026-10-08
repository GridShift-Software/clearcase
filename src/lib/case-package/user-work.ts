// User work stays outside immutable results. This module defines the types an importer
// persists next to (never inside) results, and the matching rules for anchors and seeds.
// Imported seeds remain versioned results; user edits are overlays keyed by stable seed ids,
// and a changed seed produces a visible conflict. Activation never rewrites user rows.
// Browser-safe: no Node built-ins.

/**
 * Anchor from user work (a note, register row or selection) to a document. Originals are
 * matched by fingerprint, never by ref alone across packages; the ref is only a hint.
 */
export interface DocumentAnchor {
  caseId: string;
  sha256: string;
  refAtCreation: string;
  resultsVersion: string;
}

export interface AnchorCandidate { ref: string; sha256: string }

export type AnchorMatch =
  | { status: 'exact'; ref: string } // the fingerprint maps to one ref; it may differ from refAtCreation
  | { status: 'ambiguous'; refs: string[] } // several refs share the fingerprint: disclose, let the operator choose
  | { status: 'missing' }; // the fingerprint is not in this version: disclose

/** Re-anchor by fingerprint in a (possibly renumbered) results version. */
export function matchAnchor(anchor: DocumentAnchor, originals: Iterable<AnchorCandidate>): AnchorMatch {
  const refs = [...originals].filter((o) => o.sha256 === anchor.sha256).map((o) => o.ref).sort();
  if (refs.length === 0) return { status: 'missing' };
  if (refs.length === 1) return { status: 'exact', ref: refs[0]! };
  // a shared fingerprint stays ambiguous even when one ref equals refAtCreation
  return { status: 'ambiguous', refs };
}

/** An imported seed row with its stable id and content digest (from readCandidate().seeds()). */
export interface SeedRow {
  datasetKey: string;
  /** stable across versions: derived from the seed's natural key fields */
  seedId: string;
  /** digest of the seed row's canonical content in this version */
  seedSha256: string;
  record: Readonly<Record<string, unknown>>;
}

/** A user edit of a seed, stored in user work and keyed by seed id. */
export interface SeedOverlay {
  caseId: string;
  datasetKey: string;
  seedId: string;
  /** seedSha256 the edit was made against */
  baseSeedSha256: string;
  fields: Record<string, unknown>;
}

export type SeedView =
  | { state: 'seed'; seed: SeedRow } // no user edit
  | { state: 'edited'; seed: SeedRow; overlay: SeedOverlay } // edit applies to the current seed
  | { state: 'conflict'; seed: SeedRow; overlay: SeedOverlay } // the seed changed since the edit: show both
  | { state: 'orphaned'; overlay: SeedOverlay }; // the seed is gone in this version: keep and show the edit

/** Combine the active version's seeds with user overlays without changing either. */
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
