import { digest } from '../../server/runtime/data.ts';

/** One asset-index row of the projection (local-case/project.server.ts `AssetRowW`). */
export interface StagedAsset {
  key: string; kind: string; indexed_path: string | null; parent_ref: string | null; member: string | null; ordinal: number | null;
  media_type: string; text_status: string; real_path: string | null; sha256: string | null; size: number | null; status: string; download_only: number;
}
export interface StagedDocument { ref: string; ord: number; row_json: string; state_json: string; attachments_json: string }
export interface StagedSeed { ord: number; dataset_key: string; seed_id: string; seed_sha256: string; record_json: string }
export interface StagedExpect { documents: number; assets: number; seeds: number; files: number }
/** The canonical projection of a validated package: local-case/project.server.ts `Projection`, structurally. */
export interface StagedProjection {
  documents: readonly StagedDocument[];
  assets: readonly StagedAsset[];
  seeds: readonly StagedSeed[];
  chronologyJson: string;
  overview: string;
  expect: StagedExpect;
}

const lineOf = {
  document: (d: StagedDocument) => JSON.stringify([d.ref, d.ord, d.row_json, d.state_json, d.attachments_json]),
  asset: (a: StagedAsset) => JSON.stringify([a.key, a.kind, a.indexed_path, a.parent_ref, a.member, a.ordinal, a.media_type, a.text_status, a.real_path, a.sha256, a.size, a.status, a.download_only]),
  seed: (s: StagedSeed) => JSON.stringify([s.ord, s.dataset_key, s.seed_id, s.seed_sha256, s.record_json]),
};
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : 1);
export const expectJson = (e: StagedExpect) => JSON.stringify({ documents: e.documents, assets: e.assets, seeds: e.seeds, files: e.files });

/**
 * The read model's digest, local-case/project.server.ts `readModelDigest` reproduced over WebCrypto: the same lines, the
 * same digest. It is computed over what is stored (never over a caller's claim) and checked again on every load.
 */
export async function readModelDigest(p: StagedProjection): Promise<string> {
  const lines: string[] = ['#document'];
  for (const d of [...p.documents].sort(byKey((x) => x.ref))) lines.push(lineOf.document(d));
  lines.push('#asset');
  for (const a of [...p.assets].sort(byKey((x) => x.key))) lines.push(lineOf.asset(a));
  lines.push('#seed');
  for (const s of [...p.seeds].sort((x, y) => x.ord - y.ord)) lines.push(lineOf.seed(s));
  lines.push('#chronology', p.chronologyJson, '#overview', p.overview, '#expect', expectJson(p.expect));
  return `sha256:${await digest(new TextEncoder().encode(lines.map((l) => `${l}\n`).join('')))}`;
}

/** The overview without its import-diagnostics counts, which depend on how the import checked the originals on disk. */
function overviewWithoutDiagnostics(overview: string): string {
  try { const o = JSON.parse(overview) as Record<string, unknown>; return JSON.stringify({ ...o, diagnostics: null }); } catch { return `#not-json:${overview}`; }
}

/**
 * What differs between a caller's projection and the one derived from the package bytes: empty when they describe the
 * same read model. Everything is compared except the overview's import-diagnostics counts, which only the importing side
 * can know in full; the derived projection carries the counts of the package-level validation instead, and that is what
 * is stored.
 */
export function projectionDifferences(given: StagedProjection, derived: StagedProjection): string[] {
  const out: string[] = [];
  const shaped = (p: unknown): p is StagedProjection => !!p && typeof p === 'object' && ['documents', 'assets', 'seeds'].every((k) => Array.isArray((p as Record<string, unknown>)[k]))
    && typeof (p as StagedProjection).chronologyJson === 'string' && typeof (p as StagedProjection).overview === 'string' && !!(p as StagedProjection).expect && typeof (p as StagedProjection).expect === 'object';
  if (!shaped(given)) return ['the projection is not a projection'];
  const section = <T>(name: string, a: readonly T[], b: readonly T[], key: (x: T) => string, line: (x: T) => string) => {
    if (a.length !== b.length) out.push(`${name}: ${a.length} given, ${b.length} in the package`);
    const mine = new Map(a.map((x) => [key(x), line(x)]));
    for (const x of b) if (mine.get(key(x)) !== line(x)) out.push(`${name} ${key(x)} differs from the package`);
    const theirs = new Set(b.map(key));
    for (const k of mine.keys()) if (!theirs.has(k)) out.push(`${name} ${k} is not in the package`);
  };
  try {
    section('document', given.documents, derived.documents, (d) => d.ref, lineOf.document);
    section('asset', given.assets, derived.assets, (x) => x.key, lineOf.asset);
    section('seed', given.seeds, derived.seeds, (s) => String(s.ord), lineOf.seed);
  } catch { return ['the projection rows are malformed']; }
  if (given.chronologyJson !== derived.chronologyJson) out.push('the chronology list differs from the package');
  if (overviewWithoutDiagnostics(given.overview) !== overviewWithoutDiagnostics(derived.overview)) out.push('the overview differs from the package');
  if (expectJson(given.expect) !== expectJson(derived.expect)) out.push('expect differs from the package');
  return out;
}
