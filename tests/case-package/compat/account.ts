// Where each top-level dataset of a workspace HTML ends up in the converted package (GRS-22, verification step 3).
// Shared by the synthetic unit tests and the probe that runs against a real export under .local/. It reads key names,
// counts and provenance only, never a value.
import { isObject, type JsonObject, type JsonValue } from '../../../src/lib/case-package/strict-json.ts';
import { OPAQUE_SCHEMA } from '../../../src/lib/case-package/registry.ts';
import type { Generation } from '../../../src/lib/case-package/v5/extract.ts';

export interface PackageDataset { key: string; schema: string; sourcePath: string; count: number }
export type State = 'mapped' | 'residual' | 'empty' | 'dropped' | 'unaccounted';
export interface Account { source: string; state: State; datasets: string[] }

/** The v5 source paths an app-data or app-seed key feeds; any other key stays as DATA.<key>. */
const JSON_TARGETS: Record<string, string[]> = {
  'app-data.chronology': ['DATA.chronology'], 'app-data.people': ['DATA.people'], 'app-data.entities': ['DATA.entities'],
  'app-data.contradictions': ['DATA.contradictions'], 'app-data.agreements': ['DATA.contracts'], 'app-data.bundles': ['DATA.bundles'],
  'app-data.meta': ['DATA.meta', 'META'], 'app-data.hot': ['DATA.hot', 'DATA.timeline.events'],
  'app-seed.client': ['DATA.matter'], 'app-seed.matters': ['DATA.matter'], 'app-seed.risk': ['DATA.riskMatrix'], 'app-seed.vdm': ['DATA.defenceMatrix'],
  'app-seed.inforeq': ['DATA.infoRequired'], 'app-seed.witnesses': ['DATA.witnesses'], 'app-seed.elements': ['DATA.lit.elements'],
  'app-seed.authorities': ['DATA.lit.authorities'], 'app-seed.discovery': ['window.__SCHED__'],
};
/** Source keys the adapter leaves out on purpose, each with the diagnostic that says so. */
export const DROPPED: Record<string, string> = { 'app-data.ft': 'V5_SOURCE_INDEX_DROPPED' };

const isEmpty = (v: JsonValue | undefined) => v === undefined || v === null || v === '' || (Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0);
const under = (p: string, root: string) => p === root || p.startsWith(root + '.');

/** The top-level source keys: DATA's keys and the other roots for the payload-line generations, app-data's and app-seed's keys for the JSON script. */
export function sourceKeys(generation: Generation, roots: { DATA?: JsonValue; META?: JsonValue; sched?: JsonValue; caselines?: JsonValue } | { appData: JsonObject; appSeed: JsonObject }): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  if (generation === 'json-script') {
    const r = roots as { appData: JsonObject; appSeed: JsonObject };
    for (const [k, v] of Object.entries(r.appData)) out.set(`app-data.${k}`, v);
    for (const [k, v] of Object.entries(r.appSeed)) out.set(`app-seed.${k}`, v);
    return out;
  }
  const r = roots as { DATA?: JsonValue; META?: JsonValue; sched?: JsonValue; caselines?: JsonValue };
  if (isObject(r.DATA)) for (const [k, v] of Object.entries(r.DATA)) out.set(`DATA.${k}`, v);
  if (r.META !== undefined) out.set('META', r.META);
  if (r.sched !== undefined) out.set('window.__SCHED__', r.sched);
  if (r.caselines !== undefined) out.set('window.__CASELINES_IDX__', r.caselines);
  return out;
}

/** Every source key with the package datasets that hold it and their state; `unaccounted` is a defect. */
export function accountFor(generation: Generation, keys: ReadonlyMap<string, JsonValue>, datasets: readonly PackageDataset[], diagnosticSubjects: ReadonlySet<string>): Account[] {
  return [...keys].map(([source, value]) => {
    const targets = generation === 'json-script' ? (JSON_TARGETS[source] ?? [`DATA.${source.replace(/^app-(?:data|seed)\./, '')}`]) : [source];
    const held = datasets.filter((d) => targets.some((t) => under(d.sourcePath, t)));
    const names = held.map((d) => d.key).sort();
    if (held.length) return { source, state: held.every((d) => d.schema === OPAQUE_SCHEMA) ? 'residual' : 'mapped', datasets: names };
    if (DROPPED[source] && diagnosticSubjects.has(source)) return { source, state: 'dropped', datasets: [] };
    return { source, state: isEmpty(value) ? 'empty' : 'unaccounted', datasets: [] };
  });
}

/** The datasets of a built package, from the manifest and each envelope. */
export function packageDatasets(files: ReadonlyMap<string, Uint8Array>): PackageDataset[] {
  const json = (p: string) => JSON.parse(new TextDecoder().decode(files.get(p)!)) as JsonObject;
  const manifest = json('manifest.json') as { files: { role: string; key?: string; path: string }[] };
  return manifest.files.filter((f) => f.role === 'dataset').map((f) => {
    const e = json(f.path) as { key: string; schema: string; count: number; provenance: { sourcePath: string } };
    return { key: e.key, schema: e.schema, sourcePath: e.provenance.sourcePath, count: e.count };
  });
}
