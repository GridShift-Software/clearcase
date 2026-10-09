// The committed JSON Schema 2020-12 documents: package-level schemas plus one per recognized
// dataset's `data`. Shared by export-schemas.ts (writes or checks the files) and schema-check.ts.
import type { TSchema } from 'typebox';
import { CONVERSION_REPORT, LAYOUT, V5_DATASETS } from '../../src/lib/case-package/registry.ts';
import { Acknowledgement, AssetIndex, DatasetEnvelope, Manifest } from '../../src/lib/case-package/schema.ts';

export const SCHEMA_DIR = 'src/lib/case-package/schema';
const BASE = 'https://clearcase.invalid/schema/';

export interface SchemaDoc { file: string; title: string; schema: Record<string, unknown>; dataset?: string }

/** Plain JSON copy of a TypeBox schema (drops symbol-keyed TypeBox metadata). */
function plain(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(plain);
  if (s !== null && typeof s === 'object') return Object.fromEntries(Object.keys(s).map((k) => [k, plain((s as Record<string, unknown>)[k])]));
  return s;
}

const doc = (file: string, title: string, schema: TSchema, dataset?: string): SchemaDoc => ({
  file, title, ...(dataset !== undefined && { dataset }),
  schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: BASE + file, title, ...(plain(schema) as Record<string, unknown>) },
});

export function schemaDocs(): SchemaDoc[] {
  return [
    doc('manifest.schema.json', 'ClearCase results package manifest (formatVersion 1)', Manifest),
    doc('dataset-envelope.schema.json', 'ClearCase dataset envelope (clearcase.dataset/1)', DatasetEnvelope),
    doc('assets.schema.json', 'ClearCase asset index (clearcase.assets/1)', AssetIndex),
    doc('acknowledgement.schema.json', 'ClearCase warning acknowledgement (clearcase.acknowledgement/1)', Acknowledgement),
    ...[...V5_DATASETS, LAYOUT, CONVERSION_REPORT].map((d) => doc(`data.${d.schema.replace('@', '.v')}.schema.json`, `data of ${d.schema} (${d.kind})`, d.data, d.key)),
  ];
}
