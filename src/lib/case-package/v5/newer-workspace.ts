// The newer builder of the v5 workspace HTML (META.version "V1", built from September 2026) writes the same
// `const DATA` and `const META` lines but changes several dataset shapes and adds datasets (profile, text, emails,
// whatsapp, organogram, transcripts, anchors). This module recognises that generation. The mapping of its shapes
// onto the v5 datasets follows below as pure functions; a dataset left unmapped and failing its schema is demoted
// to an opaque residual by the adapter (V5_DATASET_SHAPE_UNMAPPED), never rejected.
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import type { V5Root } from './extract.ts';

/** The newer builder stamps META.version and META.fileCount and writes a DATA.profile; v5 has none of them. */
export function isNewerGeneration(DATA: JsonObject, META: JsonObject): boolean {
  return typeof META.version === 'string' || typeof META.fileCount === 'number' || isObject(DATA.profile);
}

/** The newer roots in the v5 shapes, as far as they are mapped; every other value is carried over as written. */
export function mapNewerRoots(roots: Partial<Record<V5Root, JsonValue>>): Partial<Record<V5Root, JsonValue>> {
  return roots;
}
