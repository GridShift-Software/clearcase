import { Value } from 'typebox/value';
import { canonicalJson } from '../../../case-package/canonical.ts';
import { sha256Hex } from '../../../case-package/hash.ts';
import { KNOWN_SCHEMAS } from '../../../case-package/registry.ts';
import { DatasetEnvelope, ManifestFile, type ManifestFile as ManifestEntry } from '../../../case-package/schema.ts';
import { parseStrictJson } from '../../../case-package/strict-json.ts';
import { displayText, isSafeAppHref, renderNarrative } from '../../../case-package/render.ts';

export const RECORDS_RENDERED = 'records-rendered' as const;
export interface VerifiedDataset {
  readonly key: string;
  readonly schemaId: string;
  readonly packagePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly value: Readonly<import('../../../case-package/schema.ts').DatasetEnvelope>;
}
export interface RecordsContext { originalHref(ref: string, page: number | null): string | null | undefined }
export interface RecordsRender { html: string; markers: { records: string[]; leaves: string[] } }

type Schema = { type?: string; properties?: Record<string, Schema>; patternProperties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[] };

/** The caller supplies the entry from the separately verified, sign-off-bound manifest. */
export function verifyDatasetBytes(entry: ManifestEntry, bytes: Uint8Array): VerifiedDataset {
  if (!Value.Check(ManifestFile, entry) || entry.role !== 'dataset' || !entry.key || !entry.schema || bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) throw new Error('dataset manifest or bytes mismatch');
  const def = KNOWN_SCHEMAS.get(entry.schema);
  if (!def || def.key !== entry.key || def.kind !== entry.kind || def.required !== entry.required || entry.path !== `datasets/${entry.key}.json`) throw new Error('unsupported dataset schema');
  const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Value.Check(DatasetEnvelope, value) || value.key !== entry.key || value.schema !== entry.schema || value.kind !== entry.kind || value.required !== entry.required || value.count !== entry.count || !Value.Check(def.data, value.data)) throw new Error('dataset schema mismatch');
  const count = Array.isArray(value.data) ? value.data.length : value.data && typeof value.data === 'object' ? Object.keys(value.data).length : 1;
  if (value.count !== count) throw new Error('dataset count mismatch');
  function freeze(v: unknown): void {
    if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  }
  freeze(value);
  return Object.freeze({ key: entry.key, schemaId: entry.schema, packagePath: entry.path, sha256: entry.sha256, size: entry.size, value });
}

const token = (value: string) => sha256Hex(value);
const pointer = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');
const esc = displayText;

function schemaLeaves(schema: Schema, path: string, out: string[]): void {
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) schemaLeaves(child, `${path}/${pointer(key)}`, out);
  } else if (schema.patternProperties) {
    for (const child of Object.values(schema.patternProperties)) schemaLeaves(child, `${path}/*`, out);
  } else if (schema.items) schemaLeaves(schema.items, `${path}/*`, out);
  else if (schema.anyOf) {
    // Union variants share the same field identity.
    const before = out.length;
    for (const child of schema.anyOf) schemaLeaves(child, path, out);
    if (out.length === before) out.push(path);
  } else out.push(path);
}

function makeRender(dataset: VerifiedDataset, ctx: RecordsContext): RecordsRender {
  const def = KNOWN_SCHEMAS.get(dataset.schemaId);
  if (!def || def.key !== dataset.key || !Value.Check(DatasetEnvelope, dataset.value) || !Value.Check(def.data, dataset.value.data)) throw new Error('invalid verified dataset');
  const schema = def.data as Schema;
  const leaves: string[] = [];
  schemaLeaves(schema, '/data', leaves);
  const uniqueLeaves = [...new Set(leaves)];
  const records: string[] = [];
  const text = (s: string) => dataset.value.kind === 'authored' ? renderNarrative(s, { resolveCitationHref: ctx.originalHref }) : esc(s);
  function node(value: unknown, shape: Schema, path: string): string {
    if (shape.anyOf) shape = shape.anyOf.find(s => Value.Check(s as never, value)) ?? shape;
    if (Array.isArray(value)) {
      const child = shape.items ?? {};
      const fields = Object.entries(child.properties ?? {});
      const seen = new Map<string, number>();
      const rows = value.map((item, index) => {
        const digest = sha256Hex(canonicalJson(item)).slice(0, 12);
        const count = (seen.get(digest) ?? 0) + 1; seen.set(digest, count);
        const identity = path === '/data' && dataset.key === 'chronology' && item && typeof item === 'object' && 'ref' in item && typeof item.ref === 'string' && item.ref ? `ref:${item.ref}` : `#${digest}${count === 1 ? '' : `~${count}`}`;
        const marker = token(`${path}/${identity}`); records.push(marker);
        const childPath = `${path}/${pointer(identity)}`;
        if (fields.length && item && typeof item === 'object' && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          const cells = fields.map(([key, s]) => `<td>${Object.hasOwn(obj, key) ? node(obj[key], s, `${childPath}/${pointer(key)}`) : ''}</td>`).join('');
          const extras = Object.keys(obj).filter(k => !Object.hasOwn(child.properties!, k));
          const extra = extras.length ? `<td>${unknownFields(obj, extras, childPath)}</td>` : '<td></td>';
          return `<tr data-record="${marker}">${cells}${extra}</tr>`;
        }
        return `<tr data-record="${marker}"><td>${node(item, child, `${childPath}/${index}`)}</td></tr>`;
      }).join('');
      const heads = fields.length ? fields.map(([key]) => `<th>${esc(key)}</th>`).join('') + '<th>Unsupported source fields</th>' : '<th>Value</th>';
      return `<table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const props = shape.properties;
      const pattern = shape.patternProperties && Object.values(shape.patternProperties)[0];
      const keys = props ? Object.keys(props).filter(k => Object.hasOwn(obj, k)) : Object.keys(obj);
      const entries = keys.map(k => `<dt>${esc(k)}</dt><dd>${node(obj[k], props?.[k] ?? pattern ?? {}, `${path}/${pointer(k)}`)}</dd>`).join('');
      const extra = props ? Object.keys(obj).filter(k => !Object.hasOwn(props, k)) : [];
      return `<dl>${entries}</dl>${extra.length ? unknownFields(obj, extra, path) : ''}`;
    }
    return typeof value === 'string' ? text(value) : esc(JSON.stringify(value) ?? '');
  }
  function unknownFields(obj: Record<string, unknown>, keys: string[], path: string): string {
    return `<div><strong>Warning: unsupported source fields (DS_UNSUPPORTED_FIELD)</strong><dl>${keys.map(k => `<dt>${esc(k)}</dt><dd>${node(obj[k], {}, `${path}/${pointer(k)}`)}</dd>`).join('')}</dl></div>`;
  }
  const content = node(dataset.value.data, schema, '/data');
  const leafMarkers = uniqueLeaves.map(token);
  const legend = uniqueLeaves.map((leaf, i) => `<li data-leaf="${leafMarkers[i]}">${esc(leaf)}</li>`).join('');
  return { html: `<section><h1>Source records</h1><p>The calculated view is not yet available.</p><details><summary>Schema fields</summary><ul>${legend}</ul></details>${content}</section>`, markers: { records, leaves: leafMarkers } };
}

export function renderRecords(dataset: VerifiedDataset, ctx: RecordsContext): RecordsRender { return makeRender(dataset, ctx); }

export function recordsSectionState(dataset: VerifiedDataset, rendered: RecordsRender): typeof RECORDS_RENDERED | 'invalid' {
  try {
    const expected = makeRender(dataset, { originalHref: () => null });
    // Route resolution changes only the safe citation element; all other rendered content must match.
    const normalise = (html: string) => html.replace(/<a class="cite" href="([^"]*)">[^<]*<\/a>|<span class="cite-broken" title="Citation does not resolve">[^<]*<\/span>/g, (match, href: string | undefined) => {
      if (href !== undefined && !isSafeAppHref(href.replaceAll('&amp;', '&').replaceAll('&#39;', "'"))) return match;
      return '<citation>';
    });
    if (typeof rendered.html !== 'string' || normalise(rendered.html) !== normalise(expected.html)) return 'invalid';
    for (const kind of ['records', 'leaves'] as const) {
      const actual = rendered.markers[kind];
      if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected.markers[kind])) return 'invalid';
      const attribute = kind === 'records' ? 'data-record' : 'data-leaf';
      for (const marker of actual) if (rendered.html.split(`${attribute}="${marker}"`).length !== 2) return 'invalid';
    }
    return RECORDS_RENDERED;
  } catch { return 'invalid'; }
}
