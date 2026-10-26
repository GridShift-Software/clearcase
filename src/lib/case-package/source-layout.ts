// The v5 source layout: where each dataset sits in the four v5 roots and the key order that puts them back together.
// The converter writes it, reassembly reads it, and the hosted sign-off gate checks that the two agree (ADR 0012).
// Kept outside v5/ so the hosted Worker can use the same contract the converter does.
import { canonicalText } from './canonical.ts';
import { KNOWN_KEYS, LAYOUT, V5_SPLIT_PARENTS } from './registry.ts';
import type { DatasetEnvelope } from './schema.ts';
import { isObject, type JsonObject, type JsonValue } from './strict-json.ts';

export const V5_ROOTS = ['DATA', 'META', 'window.__SCHED__', 'window.__CASELINES_IDX__'] as const;
export type V5Root = (typeof V5_ROOTS)[number];
export type V5Roots = Partial<Record<V5Root, JsonValue>>;

export function splitSourcePath(p: string): [V5Root, string[]] {
  const root = V5_ROOTS.find((r) => p === r || p.startsWith(r + '.'));
  if (!root) throw new Error(`unknown source root in ${p}`);
  return [root, p === root ? [] : p.slice(root.length + 1).split('.')];
}

export function valueAt(roots: V5Roots, p: string): JsonValue | undefined {
  const [root, segs] = splitSourcePath(p);
  let v: JsonValue | undefined = roots[root];
  for (const s of segs) v = isObject(v) && Object.hasOwn(v, s) ? v[s] : undefined;
  return v;
}

/** The layout the converter records for `roots`: the roots present, DATA's key order and each split parent's key order. */
export function sourceLayout(roots: V5Roots): Record<string, string[]> {
  const layout: Record<string, string[]> = { roots: V5_ROOTS.filter((r) => roots[r] !== undefined), DATA: Object.keys(roots.DATA as JsonObject) };
  for (const sp of V5_SPLIT_PARENTS) { const v = valueAt(roots, sp); if (isObject(v)) layout[sp] = Object.keys(v); }
  return layout;
}

export function reassembleV5(datasets: Iterable<Readonly<DatasetEnvelope>>): V5Roots {
  const envs = [...datasets];
  const layout = envs.find((e) => e.key === LAYOUT.key)?.data as Record<string, string[]> | undefined;
  if (!layout) throw new Error('source-layout dataset missing');
  const out: V5Roots = {};
  const DATA: JsonObject = {};
  for (const e of envs) {
    const sp = e.provenance.sourcePath;
    if (sp.startsWith('(')) continue;
    const [root, segs] = splitSourcePath(sp);
    if (segs.length === 0) { out[root] = structuredClone(e.data) as JsonValue; continue; }
    let cur = DATA;
    for (const s of segs.slice(0, -1)) cur = (isObject(cur[s]) ? cur[s] : (cur[s] = {})) as JsonObject;
    cur[segs[segs.length - 1]!] = structuredClone(e.data) as JsonValue;
  }
  const order = (o: JsonObject, keys: string[]): JsonObject => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]!]));
  const D = order(DATA, layout.DATA ?? []);
  for (const [k, keys] of Object.entries(layout)) if (k.startsWith('DATA.')) { const c = k.slice(5); if (isObject(D[c])) D[c] = order(D[c] as JsonObject, keys); }
  if ((layout.roots ?? []).includes('DATA')) out.DATA = D;
  return out;
}

/**
 * Whether the datasets and their source layout round-trip as the converter defines it: every registered dataset sits at
 * its registered source path, no path is used twice, reassembly gives back every dataset unchanged, and the layout the
 * converter would record for the reassembled roots is exactly this one. The key orders are checked for consistency with
 * the datasets; the original HTML is not available here, so this does not prove they match its bytes.
 */
export function sourceLayoutRoundTrips(datasets: readonly Readonly<DatasetEnvelope>[]): boolean {
  const layout = datasets.find((e) => e.key === LAYOUT.key);
  if (!layout) return false;
  const placed = datasets.filter((e) => !e.provenance.sourcePath.startsWith('('));
  const paths = placed.map((e) => e.provenance.sourcePath);
  if (new Set(paths).size !== paths.length) return false;
  if (datasets.some((e) => { const def = KNOWN_KEYS.get(e.key); return def !== undefined && def.sourcePath !== e.provenance.sourcePath; })) return false;
  try {
    const back = reassembleV5(datasets);
    return canonicalText(sourceLayout(back)) === canonicalText(layout.data)
      && placed.every((e) => { const v = valueAt(back, e.provenance.sourcePath); return v !== undefined && canonicalText(v) === canonicalText(e.data); });
  } catch {
    return false;
  }
}
