// Inverse of the adapter's dataset split: package datasets -> the four v5 roots. Used to prove
// that conversion is lossless: canonical(reassembled) === canonical(source) for each root.
import type { DatasetEnvelope } from '../schema.ts';
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import { LAYOUT } from '../registry.ts';
import { splitSourcePath } from './adapter.ts';
import type { V5Root } from './extract.ts';

export function reassembleV5(datasets: Iterable<Readonly<DatasetEnvelope>>): Partial<Record<V5Root, JsonValue>> {
  const envs = [...datasets];
  const layout = envs.find((e) => e.key === LAYOUT.key)?.data as Record<string, string[]> | undefined;
  if (!layout) throw new Error('source-layout dataset missing');
  const out: Partial<Record<V5Root, JsonValue>> = {};
  const DATA: JsonObject = {};
  for (const e of envs) {
    const sp = e.provenance.sourcePath;
    if (sp.startsWith('(')) continue; // layout and adapter report
    const [root, segs] = splitSourcePath(sp);
    if (segs.length === 0) { out[root] = structuredClone(e.data) as JsonValue; continue; }
    let cur = DATA;
    for (const s of segs.slice(0, -1)) cur = (isObject(cur[s]) ? cur[s] : (cur[s] = {})) as JsonObject;
    cur[segs[segs.length - 1]!] = structuredClone(e.data) as JsonValue;
  }
  // restore the original key order of DATA and the split containers (cosmetic; canonical comparison sorts keys)
  const order = (o: JsonObject, keys: string[]): JsonObject => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]!]));
  const D = order(DATA, layout.DATA ?? []);
  for (const [k, keys] of Object.entries(layout)) if (k.startsWith('DATA.')) { const c = k.slice(5); if (isObject(D[c])) D[c] = order(D[c] as JsonObject, keys); }
  if ((layout.roots ?? []).includes('DATA')) out.DATA = D;
  return out;
}
