import { Value } from 'typebox/value';
import { sha256Hex } from '../../../case-package/hash.ts';
import { KNOWN_SCHEMAS, NON_CITATION_FIELDS } from '../../../case-package/registry.ts';
import { DatasetEnvelope, ManifestFile, type ManifestFile as ManifestEntry } from '../../../case-package/schema.ts';
import { escapePointer, parseStrictJson } from '../../../case-package/strict-json.ts';
import { displayText, escapeHtml, renderNarrative, revealInvisible } from '../../../case-package/render.ts';
import { elementIds } from '../../../case-package/validate.ts';
import { originalHref } from '../paths.ts';

export const RECORDS_RENDERED = 'records-rendered' as const;
declare const verifiedBrand: unique symbol;
/** Only `verifyDatasetBytes` makes one: the brand is a type, and a module-private set checks it at run time. */
export interface VerifiedDataset {
  readonly [verifiedBrand]: true;
  readonly key: string;
  readonly schemaId: string;
  readonly packagePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly value: Readonly<import('../../../case-package/schema.ts').DatasetEnvelope>;
}
export interface RecordsContext { originalHref(ref: string, page: number | null): string | null | undefined }
/** Shared by a records reader and its publication display check, using authorized case originals only. */
export function recordsContext(caseId: string, originals: ReadonlyMap<string, string>): RecordsContext {
  return { originalHref: (ref, page) => {
    const asset = originals.get(ref);
    return asset ? `${originalHref(caseId, asset)}/view${page ? `?page=${page}` : ''}` : null;
  } };
}
/**
 * The ref-to-original map a records view links citations through: each attributed ref whose original is still one of the case's own
 * originals. The client route and the publication gate both build it here, so the gate checks the exact page the route serves.
 */
export function recordsOriginals(attribution: readonly { ref: string; assetId: string }[], caseOriginals: Iterable<string>): Map<string, string> {
  const assets = new Set(caseOriginals);
  return new Map(attribution.filter(a => assets.has(a.assetId)).map(a => [a.ref, a.assetId]));
}
export interface RecordsRender { html: string; markers: { records: string[]; leaves: string[] } }

const verifiedDatasets = new WeakSet<object>();
function assertVerified(dataset: VerifiedDataset): void {
  if (!verifiedDatasets.has(dataset)) throw new Error('dataset was not produced by verifyDatasetBytes');
}

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
  const dataset = Object.freeze({ key: entry.key, schemaId: entry.schema, packagePath: entry.path, sha256: entry.sha256, size: entry.size, value }) as VerifiedDataset;
  verifiedDatasets.add(dataset);
  return dataset;
}

function schemaLeaves(schema: Schema, path: string, out: string[]): void {
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) schemaLeaves(child, `${path}/${escapePointer(key)}`, out);
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

const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object';
/** Whether the schema names `ref` as the id of the dataset's top-level rows (the validator's rule). */
const refIdentified = (schemaId: string): boolean => NON_CITATION_FIELDS[schemaId]?.has('ref') === true;

export function renderRecords(dataset: VerifiedDataset, ctx: RecordsContext): RecordsRender {
  assertVerified(dataset);
  const def = KNOWN_SCHEMAS.get(dataset.schemaId);
  if (!def || def.key !== dataset.key || !Value.Check(DatasetEnvelope, dataset.value) || !Value.Check(def.data, dataset.value.data)) throw new Error('invalid verified dataset');
  const schema = def.data as Schema;
  const leaves: string[] = [];
  schemaLeaves(schema, '/data', leaves);
  const uniqueLeaves = [...new Set(leaves)];
  const records: string[] = [];
  const idField = refIdentified(dataset.schemaId) ? 'ref' : null;
  const text = (s: string) => dataset.value.kind === 'authored' ? renderNarrative(s, { resolveCitationHref: ctx.originalHref }) : displayText(s);
  /** A value cell. A scalar's cell carries `data-value`, bound to the value's stable path, so the check can find it. */
  function cell(tag: 'td' | 'dd', value: unknown, shape: Schema, path: string): string {
    const inner = node(value, shape, path);
    return isScalar(value) ? `<${tag} data-value="${sha256Hex(path)}">${inner}</${tag}>` : `<${tag}>${inner}</${tag}>`;
  }
  function node(value: unknown, shape: Schema, path: string): string {
    if (shape.anyOf) shape = shape.anyOf.find(s => Value.Check(s as never, value)) ?? shape;
    if (Array.isArray(value)) {
      const child = shape.items ?? {};
      const fields = Object.entries(child.properties ?? {});
      const ids = elementIds(value, path === '/data' ? idField : null);
      const rows = value.map((item, index) => {
        const childPath = `${path}/${ids[index]}`;
        const marker = sha256Hex(childPath); records.push(marker);
        if (fields.length && item && typeof item === 'object' && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          const cells = fields.map(([key, s]) => Object.hasOwn(obj, key) ? cell('td', obj[key], s, `${childPath}/${escapePointer(key)}`) : '<td></td>').join('');
          const extras = Object.keys(obj).filter(k => !Object.hasOwn(child.properties!, k));
          const extra = extras.length ? `<td>${unknownFields(obj, extras, childPath)}</td>` : '<td></td>';
          return `<tr data-record="${marker}">${cells}${extra}</tr>`;
        }
        return `<tr data-record="${marker}">${cell('td', item, child, childPath)}</tr>`;
      }).join('');
      const heads = fields.length ? fields.map(([key]) => `<th>${displayText(key)}</th>`).join('') + '<th>Unsupported source fields</th>' : '<th>Value</th>';
      return `<table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const props = shape.properties;
      const pattern = shape.patternProperties && Object.values(shape.patternProperties)[0];
      const keys = props ? Object.keys(props).filter(k => Object.hasOwn(obj, k)) : Object.keys(obj);
      const entries = keys.map(k => `<dt>${displayText(k)}</dt>${cell('dd', obj[k], props?.[k] ?? pattern ?? {}, `${path}/${escapePointer(k)}`)}`).join('');
      const extra = props ? Object.keys(obj).filter(k => !Object.hasOwn(props, k)) : [];
      return `<dl>${entries}</dl>${extra.length ? unknownFields(obj, extra, path) : ''}`;
    }
    return typeof value === 'string' ? text(value) : displayText(JSON.stringify(value) ?? '');
  }
  function unknownFields(obj: Record<string, unknown>, keys: string[], path: string): string {
    return `<div><strong>Warning: unsupported source fields (DS_UNSUPPORTED_FIELD)</strong><dl>${keys.map(k => `<dt>${displayText(k)}</dt>${cell('dd', obj[k], {}, `${path}/${escapePointer(k)}`)}`).join('')}</dl></div>`;
  }
  const data = dataset.value.data;
  const content = isScalar(data) ? `<div data-value="${sha256Hex('/data')}">${node(data, schema, '/data')}</div>` : node(data, schema, '/data');
  const leafMarkers = uniqueLeaves.map(sha256Hex);
  const legend = uniqueLeaves.map((leaf, i) => `<li data-leaf="${leafMarkers[i]}">${displayText(leaf)}</li>`).join('');
  return { html: `<section><h1>Source records</h1><p>The calculated view is not yet available.</p><details><summary>Schema fields</summary><ul>${legend}</ul></details>${content}</section>`, markers: { records, leaves: leafMarkers } };
}

/**
 * What the data itself says the page must hold, derived by walking the data and not by reading the render:
 * a marker per array element (the validator's ids, see `elementIds`) and the html of every scalar value.
 */
function expectedFromData(dataset: VerifiedDataset, ctx: RecordsContext): { records: string[]; values: Map<string, string>; duplicate: boolean } {
  const records: string[] = [];
  const values = new Map<string, string>();
  let duplicate = false;
  const idField = refIdentified(dataset.schemaId) ? 'ref' : null;
  const authored = dataset.value.kind === 'authored';
  // Spelled out here, not through the renderer's own text function, so a defect there shows up as a difference.
  const plain = (s: string) => escapeHtml(revealInvisible(s.replace(/\r\n?/g, '\n')));
  const html = (v: unknown) => typeof v !== 'string' ? plain(JSON.stringify(v) ?? '') : authored ? renderNarrative(v, { resolveCitationHref: ctx.originalHref }) : plain(v);
  function walk(value: unknown, at: string): void {
    if (Array.isArray(value)) {
      const ids = elementIds(value, at === '/data' ? idField : null);
      value.forEach((el, i) => { const childAt = `${at}/${ids[i]}`; records.push(sha256Hex(childAt)); walk(el, childAt); });
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${at}/${escapePointer(k)}`);
    } else {
      const marker = sha256Hex(at);
      if (values.has(marker)) duplicate = true;
      values.set(marker, html(value));
    }
  }
  walk(dataset.value.data, '/data');
  return { records, values, duplicate };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
// Multiset equality in linear time: the same strings with the same counts, in any order.
const sameMultiset = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const x of b) {
    const n = counts.get(x);
    if (!n) return false;
    if (n === 1) counts.delete(x); else counts.set(x, n - 1);
  }
  return counts.size === 0;
};

/**
 * `records-rendered` only if the page is exactly the one the verified dataset and the route produce, and
 * the data's own records and values are on it. Linear in the size of the page.
 */
export function recordsSectionState(dataset: VerifiedDataset, rendered: RecordsRender, ctx: RecordsContext): typeof RECORDS_RENDERED | 'invalid' {
  try {
    if (!verifiedDatasets.has(dataset) || typeof rendered.html !== 'string') return 'invalid';
    const expected = renderRecords(dataset, ctx);
    if (rendered.html !== expected.html) return 'invalid';
    for (const kind of ['records', 'leaves'] as const) {
      const actual = rendered.markers[kind];
      if (!Array.isArray(actual) || !sameList(actual, expected.markers[kind])) return 'invalid';
    }
    // One pass over the page: every marker once, and the html of every value cell.
    const attributeCounts = new Map<string, number>();
    for (const m of rendered.html.matchAll(/ data-(record|leaf)="([0-9a-f]{64})"/g)) {
      const key = `${m[1]}:${m[2]}`;
      attributeCounts.set(key, (attributeCounts.get(key) ?? 0) + 1);
    }
    const cells = new Map<string, string>();
    for (const m of rendered.html.matchAll(/<(td|dd|div) data-value="([0-9a-f]{64})">(.*?)<\/\1>/gs)) {
      if (cells.has(m[2]!)) return 'invalid';
      cells.set(m[2]!, m[3]!);
    }
    const fromData = expectedFromData(dataset, ctx);
    if (fromData.duplicate || cells.size !== fromData.values.size) return 'invalid';
    for (const [marker, valueHtml] of fromData.values) if (cells.get(marker) !== valueHtml) return 'invalid';
    if (!sameMultiset(rendered.markers.records, fromData.records)) return 'invalid';
    for (const marker of rendered.markers.records) if (attributeCounts.get(`record:${marker}`) !== 1) return 'invalid';
    for (const marker of rendered.markers.leaves) if (attributeCounts.get(`leaf:${marker}`) !== 1) return 'invalid';
    return RECORDS_RENDERED;
  } catch { return 'invalid'; }
}
