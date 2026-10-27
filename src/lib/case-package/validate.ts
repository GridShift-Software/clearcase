import Value from 'typebox/value';
import { canonicalJson, canonicalText } from './canonical.ts';
import type { DiagSink } from './diagnostics.ts';
import { inputRevisionId, pathAssetKey, resultsVersionOf, sha256Hex } from './hash.ts';
import type { Limits } from './limits.ts';
import { classifyLink, MAX_LINK } from './links.ts';
import { capabilityOf, isContainer, textStatusConsistent, type TextStatus } from './media.ts';
import { checkRelPath, decodeLegacyLocator, foldPath, isReservedPath } from './paths.ts';
import { CITATION_TOKEN, isAssetKey, isPathKey, isRef, parseCitationToken, REF_IN_TEXT, REF_PATTERN } from './refs.ts';
import {
  EXTRA_CITATION_ARRAYS, KNOWN_KEYS, KNOWN_SCHEMAS, LINK_FIELDS, NON_CITATION_FIELDS, OPAQUE_SCHEMA, REQUIRED_DATASETS,
  SEED_DATASETS, STORE_KEY, USERWORK_KEYS, USERWORK_SOURCES,
} from './registry.ts';
import { Asset, AssetIndex, ASSET_INDEX, DatasetEnvelope, FORMAT, FORMAT_VERSION, Manifest } from './schema.ts';
import type { Snapshot } from './source.ts';
import { isViewTemplate, templateLinkText } from './view-content.ts';
import { cutText, decodeUtf8Strict, escapePointer, isObject, parseStrictJson, StrictJsonError, type JsonObject, type JsonValue } from './strict-json.ts';

export interface CitationHit { ref: string; file: string; pointer: string; inline: boolean }

export interface ValidatedPackage {
  manifest: Manifest;
  manifestSha256: string;
  resultsVersion: string;
  inputRevisionId: string;
  files: Map<string, Uint8Array>;
  datasets: Map<string, DatasetEnvelope>;
  assets: Record<string, Asset>;
  register: Set<string>;
  citations: CitationHit[];
}

const errorsOf = (schema: unknown, v: unknown, n: number) =>
  [...Value.Errors(schema as never, v)].slice(0, n).map((e) => ({ path: e.instancePath, message: `${e.instancePath || '/'} ${e.message}` }));

const countOf = (data: unknown): number => (Array.isArray(data) ? data.length : isObject(data) ? Object.keys(data).length : 1);

function parseFile(bytes: Uint8Array, file: string, sink: DiagSink): JsonValue | undefined {
  try {
    return parseStrictJson(decodeUtf8Strict(bytes));
  } catch (e) {
    if (e instanceof StrictJsonError) { sink.add(e.code, e.message, { file, pointer: e.pointer }); return undefined; }
    throw e;
  }
}

const decoder = new TextDecoder();

export function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return canonicalJson(v); } catch { return '(unprintable)'; }
}

export function validateSnapshot(snap: Snapshot, sink: DiagSink, L: Limits, check: () => void = () => {}): ValidatedPackage | null {
  const mBytes = snap.files.get('manifest.json');
  if (!snap.present.has('manifest.json')) { sink.add('PKG_MANIFEST_MISSING', 'manifest.json not found at the package root'); return null; }
  if (!mBytes) { sink.add('PKG_TOO_LARGE', `manifest.json is larger than ${L.manifestBytes} bytes`, { file: 'manifest.json' }); return null; }
  const mVal = parseFile(mBytes, 'manifest.json', sink);
  if (mVal === undefined) return null;
  if (!isObject(mVal) || mVal.format !== FORMAT) {
    sink.add('PKG_NOT_A_PACKAGE', `manifest.format must be "${FORMAT}"`, { file: 'manifest.json', pointer: '/format' });
    return null;
  }
  if (mVal.formatVersion !== FORMAT_VERSION) {
    const seen = Object.hasOwn(mVal, 'formatVersion') ? JSON.stringify(mVal.formatVersion).slice(0, 40) : Object.hasOwn(mVal, 'schemaVersion') ? `schemaVersion ${JSON.stringify(mVal.schemaVersion).slice(0, 20)}` : 'none';
    sink.add('VER_UNSUPPORTED', `formatVersion ${seen} is not supported; this reader understands formatVersion ${FORMAT_VERSION}. Convert the package again or upgrade ClearCase.`, { file: 'manifest.json', pointer: '/formatVersion', subject: seen });
    return null;
  }
  if (!Value.Check(Manifest, mVal)) {
    for (const er of errorsOf(Manifest, mVal, 5)) sink.add('PKG_MANIFEST_INVALID', er.message, { file: 'manifest.json', pointer: er.path });
    return null;
  }
  const manifest = mVal as unknown as Manifest;
  for (const k of storeKeysIn(manifest.extensions ?? {})) sink.add('DS_USERWORK_EMBEDDED', 'a browser user-work store key is embedded in manifest extensions', { file: 'manifest.json', pointer: '/extensions', subject: k.slice(0, 64) });
  if (canonicalText(mVal) !== decoder.decode(mBytes)) sink.add('PKG_NONCANONICAL', 'manifest.json is not canonical JSON', { file: 'manifest.json' });
  const irId = inputRevisionId(manifest.inputRevision.sources);
  if (irId !== manifest.inputRevision.id) sink.add('PKG_INPUT_REVISION_MISMATCH', 'inputRevision.id does not match its sources', { file: 'manifest.json', pointer: '/inputRevision/id' });

  const listed = new Set<string>(['manifest.json']);
  const folded = new Map<string, string>(); folded.set('manifest.json', 'manifest.json');
  const files = new Map<string, Uint8Array>([['manifest.json', mBytes]]);
  const loaded: { f: Manifest['files'][number]; value: JsonValue }[] = [];
  let assetsValue: JsonValue | undefined;
  let assetsListed = 0;
  let total = mBytes.byteLength;
  if (manifest.files.length + 1 > L.packageFiles) sink.add('PKG_TOO_MANY_FILES', `more than ${L.packageFiles} files listed`, { file: 'manifest.json' });
  if (manifest.files.filter((f) => f.role === 'dataset').length > L.datasets) sink.add('PKG_TOO_MANY_FILES', `more than ${L.datasets} datasets`, { file: 'manifest.json' });
  manifest.files.forEach((f, i) => {
    const at = { file: 'manifest.json', pointer: `/files/${i}/path`, subject: f.path.slice(0, 200) };
    const pv = checkRelPath(f.path);
    if (!pv.ok) { sink.add(pv.traversal ? 'PKG_PATH_TRAVERSAL' : 'PKG_PATH_INVALID', `listed path is unsafe: ${pv.reason}`, at); return; }
    if (f.role === 'preview' && (foldPath(f.path).startsWith('datasets/') || foldPath(f.path) === 'assets.json')) {
      sink.add('PKG_PREVIEW_PATH_INVALID', 'preview cannot occupy a dataset or asset index path', at);
    }
    const expected = f.role === 'dataset' ? `datasets/${f.key}.json` : f.role === 'assets' ? 'assets.json' : null;
    if (expected !== null && f.path !== expected) { sink.add('PKG_PATH_INVALID', `a ${f.role} file must be at ${f.role === 'dataset' ? 'datasets/<key>.json' : 'assets.json'}`, at); return; }
    if (f.role === 'dataset' && (f.kind === undefined || f.schema === undefined || f.required === undefined || f.count === undefined)) {
      sink.add('PKG_MANIFEST_INVALID', 'dataset entries need key, kind, schema, required and count', { ...at, pointer: `/files/${i}` });
    }
    const fk = foldPath(f.path);
    if (folded.has(fk)) { sink.add('PKG_DUPLICATE_PATH', `also listed as ${folded.get(fk)}`, at); return; }
    folded.set(fk, f.path);
    listed.add(f.path);
    if (f.role === 'assets') assetsListed++;
    const size = snap.present.get(f.path);
    if (size === undefined) { sink.add('PKG_FILE_MISSING', 'listed file not found', at); return; }
    if (size > L.fileBytes) { sink.add('PKG_TOO_LARGE', `file is larger than ${L.fileBytes} bytes`, at); return; }
    const bytes = snap.files.get(f.path);
    if (!bytes) { sink.add('PKG_FILE_MISSING', 'listed file could not be read', at); return; }
    total += bytes.byteLength;
    if (f.role === 'preview' && (bytes.length < 5 || decoder.decode(bytes.subarray(0, 5)) !== '%PDF-')) sink.add('PKG_PREVIEW_INVALID', 'preview must be a PDF', { file: f.path });
    if (bytes.byteLength !== f.size || sha256Hex(bytes) !== f.sha256) { sink.add('PKG_FILE_HASH_MISMATCH', 'size or sha256 differs from the manifest', { ...at, file: f.path }); return; }
    files.set(f.path, bytes);
    check();
    if (f.role === 'preview') return;
    const v = parseFile(bytes, f.path, sink);
    if (v === undefined) return;
    if (canonicalText(v) !== decoder.decode(bytes)) sink.add('PKG_NONCANONICAL', 'file is not canonical JSON', { file: f.path });
    if (f.role === 'dataset') loaded.push({ f, value: v }); else assetsValue = v;
  });
  if (total > L.packageBytes) sink.add('PKG_TOO_LARGE', `listed files exceed ${L.packageBytes} bytes`, { file: 'manifest.json' });
  for (const p of snap.present.keys()) if (!listed.has(p)) sink.add('PKG_UNLISTED_FILE', 'not listed in the manifest; ignored and never imported', { file: p, subject: p });
  if (assetsListed !== 1) sink.add('PKG_ROLE_INVALID', 'exactly one assets.json must be listed', { file: 'manifest.json' });

  const datasets = new Map<string, DatasetEnvelope>();
  for (const { f, value } of loaded) {
    check();
    const file = f.path;
    if (!Value.Check(DatasetEnvelope, value)) { for (const er of errorsOf(DatasetEnvelope, value, 3)) sink.add('DS_ENVELOPE_INVALID', er.message, { file, pointer: er.path }); continue; }
    const env = value as unknown as DatasetEnvelope;
    if (env.key !== f.key || env.kind !== f.kind || env.schema !== f.schema || env.required !== f.required || env.count !== f.count) {
      sink.add('DS_MANIFEST_MISMATCH', 'envelope key, kind, schema, required or count disagrees with the manifest', { file, subject: env.key });
    }
    const actual = countOf(env.data);
    if (actual !== env.count) sink.add('DS_COUNT_MISMATCH', `envelope declares ${env.count} records, the data holds ${actual}`, { file, pointer: '/count', subject: env.key });
    if (USERWORK_KEYS.has(env.key) || env.key.startsWith('user-') || USERWORK_SOURCES.has(env.provenance.source)) {
      sink.add('DS_USERWORK_EMBEDDED', 'user notes and registers belong to the workspace, never to results', { file, subject: env.key });
      continue;
    }
    const registered = KNOWN_KEYS.get(env.key);
    if (registered && (registered.schema !== env.schema || registered.required !== env.required)) {
      sink.add('DS_SCHEMA_UNSUPPORTED', `dataset ${env.key} must use schema ${registered.schema} (required: ${registered.required}); this reader does not understand ${env.schema} for it`, { file, subject: env.key });
      datasets.set(env.key, env);
      continue;
    }
    const def = KNOWN_SCHEMAS.get(env.schema);
    if (!def) {
      if (env.required) sink.add('DS_SCHEMA_UNSUPPORTED', `required dataset schema ${env.schema} is not understood by this reader`, { file, subject: env.schema });
      else sink.add('DS_UNKNOWN_SCHEMA', env.schema === OPAQUE_SCHEMA ? 'opaque dataset: preserved, not rendered' : `schema ${env.schema} is unknown; preserved, not rendered`, { file, subject: env.schema });
    } else {
      if (def.key !== env.key || def.kind !== env.kind) sink.add('DS_MANIFEST_MISMATCH', `schema ${env.schema} belongs to the ${def.kind} dataset ${def.key}`, { file, subject: env.key });
      checkShape(def.data, env, file, sink);
    }
    datasets.set(env.key, env);
  }
  for (const k of REQUIRED_DATASETS) if (!KNOWN_SCHEMAS.has(datasets.get(k)?.schema ?? '')) sink.add('DS_REQUIRED_MISSING', `dataset ${k} is required`, { subject: k });

  const register = new Set<string>();
  const chron = datasets.get('chronology');
  const chronRows = chron && Array.isArray(chron.data) ? (chron.data as JsonObject[]) : [];
  chronRows.forEach((r, i) => {
    const ref: unknown = isObject(r) ? r.ref : undefined;
    const raw = ref as string | undefined;
    const at = { file: 'datasets/chronology.json', pointer: `/data/${i}/ref` };
    if (!isRef(ref)) { sink.add('ID_REF_INVALID', `ref is missing or does not match ${REF_PATTERN}`, { ...at, subject: typeof raw === 'string' ? cutText(raw, 40) : `row ${i}`, stablePointer: typeof raw === 'string' ? undefined : `/data/${i}/ref` }); return; }
    if (register.has(ref)) sink.add('ID_DUPLICATE', `ref ${ref} appears more than once`, { ...at, subject: ref });
    register.add(ref);
    if (r.text_status !== undefined && !['extracted', 'ocr', 'none', 'pending'].includes(r.text_status as string)) {
      sink.add('DS_ENUM_UNKNOWN', `text_status ${JSON.stringify(textOf(r.text_status).slice(0, 32))} is not extracted, ocr, none or pending`, { file: at.file, pointer: `/data/${i}/text_status`, subject: ref });
    }
  });

  const referencedPreviews = new Map<string, string>();
  let assets: Record<string, Asset> = Object.create(null);
  if (assetsValue !== undefined) {
    if (isObject(assetsValue) && assetsValue.index === ASSET_INDEX && assetsValue.root === 'case-folder' && isObject(assetsValue.assets) && Object.keys(assetsValue).length === 3) {
      for (const [k, a] of Object.entries(assetsValue.assets)) {
        const at = { file: 'assets.json', pointer: `/assets/${escapePointer(k)}`, subject: k.slice(0, 40) };
        if (!isAssetKey(k)) { sink.add('ID_REF_INVALID', 'asset key must be a ref or <ref>.a<ordinal>', at); continue; }
        const p = isObject(a) ? a.path : undefined;
        if (p !== undefined) {
          const pv = checkRelPath(p);
          if (!pv.ok) { sink.add(pv.traversal ? 'ASSET_PATH_TRAVERSAL' : 'ASSET_PATH_INVALID', `original path is unsafe: ${pv.reason}`, { ...at, pointer: `${at.pointer}/path` }); continue; }
        }
        if (!Value.Check(Asset, a)) { sink.add('DS_SHAPE_INVALID', 'asset entry does not match the asset schema', at); continue; }
        if (isPathKey(k) && ((a as Asset).kind === 'embedded' || (a as Asset).parentRef !== undefined || pathAssetKey((a as { path: string }).path) !== k)) {
          sink.add('ID_REF_INVALID', 'a package-file key must be P-<first 16 hex digits of sha256(path)> of a file or missing asset without a parent', at);
          continue;
        }
        assets[k] = a as Asset;
      }
    } else if (!Value.Check(AssetIndex, assetsValue)) {
      for (const er of errorsOf(AssetIndex, assetsValue, 3)) sink.add('DS_ENVELOPE_INVALID', er.message, { file: 'assets.json', pointer: er.path });
    }
    if (Object.keys(assets).length > L.assets) sink.add('PKG_TOO_LARGE', `more than ${L.assets} assets`, { file: 'assets.json' });
    checkAssets(assets, register, sink, L);
    const previewEntries = new Map(manifest.files.filter((f) => f.role === 'preview').map((f) => [f.path, f]));
    for (const [ref, asset] of Object.entries(assets)) {
      if (asset.kind !== 'file' || !asset.preview) continue;
      const preview = asset.preview;
      const at = { file: 'assets.json', pointer: `/assets/${escapePointer(ref)}/preview`, subject: ref };
      const entry = previewEntries.get(preview.path);
      const previous = referencedPreviews.get(preview.path);
      if (preview.originalSha256 !== asset.sha256 || !entry || entry.sha256 !== preview.sha256 || entry.size !== preview.size || (previous !== undefined && previous !== asset.sha256)) {
        sink.add('PKG_PREVIEW_BINDING_MISMATCH', 'preview must match its original, any shared original, and its manifest entry', at);
      }
      referencedPreviews.set(preview.path, asset.sha256);
    }
    if (chron?.schema === 'v5.chronology@1') {
      chronRows.forEach((r, i) => {
        if (!isObject(r) || !isRef(r.ref) || typeof r.url !== 'string') return;
        const a = assets[r.ref];
        if (!a || a.kind === 'embedded') return;
        const d = decodeLegacyLocator(r.url);
        if (d.ok && d.path !== a.path && d.path.normalize('NFC') !== a.path.normalize('NFC')) sink.add('LINK_ASSET_MISMATCH', 'url and indexed original path disagree', { file: 'datasets/chronology.json', pointer: `/data/${i}/url`, subject: r.ref });
      });
    }
  }

  for (const [i, entry] of manifest.files.entries()) {
    if (entry.role === 'preview' && !referencedPreviews.has(entry.path)) sink.add('PKG_PREVIEW_UNREFERENCED', 'preview is not referenced by a file asset', { file: 'manifest.json', pointer: `/files/${i}/path`, subject: entry.path });
  }

  const targets = new Set<string>([...register, ...Object.keys(assets)]);
  const citations: CitationHit[] = [];
  for (const env of datasets.values()) { check(); scanDataset(env, { sink, file: `datasets/${env.key}.json`, targets, citations, check }); }

  checkMetaCounts(datasets, sink);
  checkSeeds(datasets, sink);

  const resultsVersion = resultsVersionOf({ formatVersion: manifest.formatVersion, caseId: manifest.case.id, inputRevisionId: manifest.inputRevision.id, files: manifest.files });
  if (resultsVersion !== manifest.resultsVersion) sink.add('PKG_VERSION_MISMATCH', 'resultsVersion is not the digest of the listed content', { file: 'manifest.json', pointer: '/resultsVersion' });
  return { manifest, manifestSha256: sha256Hex(mBytes), resultsVersion, inputRevisionId: irId, files, datasets, assets, register, citations };
}


function recordSubject(data: unknown, path: string): string {
  const m = /^\/(\d+)/.exec(path);
  if (m && Array.isArray(data)) {
    const row = data[Number(m[1])];
    if (isObject(row) && typeof row.ref === 'string') return row.ref.slice(0, 40);
    return `#${m[1]}`;
  }
  return path.split('/').slice(0, 3).join('/') || '/';
}

function checkShape(schema: unknown, env: DatasetEnvelope, file: string, sink: DiagSink): void {
  if (!Value.Check(schema as never, env.data)) {
    for (const er of errorsOf(schema, env.data, 50)) {
      sink.add('DS_SHAPE_INVALID', `${env.schema}: ${er.message}`, { file, pointer: `/data${er.path}`, subject: recordSubject(env.data, er.path) });
    }
    return;
  }
  const unknown = new Map<string, number>();
  unknownFields(schema as Sch, env.data, '', unknown);
  for (const [ptr, n] of unknown) {
    const key = ptr.slice(ptr.lastIndexOf('/') + 1);
    sink.add('DS_UNSUPPORTED_FIELD', `field ${JSON.stringify(key.slice(0, 64))} on ${n} record(s) is not in ${env.schema}; preserved, not rendered`, { file, pointer: `/data${ptr}`, subject: key.slice(0, 64) });
  }
}

type Sch = { type?: string; properties?: Record<string, Sch>; patternProperties?: Record<string, Sch>; additionalProperties?: boolean | Sch; items?: Sch | false; prefixItems?: Sch[]; anyOf?: Sch[] };

function unknownFields(s: Sch, v: unknown, ptr: string, out: Map<string, number>): void {
  if (s.anyOf) {
    const branch = s.anyOf.find((b) => Value.Check(b as never, v));
    if (branch) unknownFields(branch, v, ptr, out);
    return;
  }
  if (Array.isArray(v)) {
    if (s.prefixItems) v.forEach((x, k) => { const p = s.prefixItems![k]; if (p) unknownFields(p, x, `${ptr}/*`, out); });
    else if (s.items && typeof s.items === 'object') for (const x of v) unknownFields(s.items, x, `${ptr}/*`, out);
    return;
  }
  if (!isObject(v)) return;
  const pattern = s.patternProperties ? Object.values(s.patternProperties)[0] : undefined;
  for (const [k, x] of Object.entries(v)) {
    const sub = s.properties && Object.hasOwn(s.properties, k) ? s.properties[k] : pattern;
    if (sub) unknownFields(sub, x, `${ptr}/${pattern && !(s.properties && Object.hasOwn(s.properties, k)) ? '*' : escapePointer(k)}`, out);
    else if (s.properties && s.additionalProperties !== false) {
      const key = `${ptr}/${escapePointer(k)}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
}


function checkAssets(assets: Record<string, Asset>, register: Set<string>, sink: DiagSink, L: Limits): void {
  const F = 'assets.json';
  const byPath = new Map<string, string>();
  const byFold = new Map<string, string>();
  const bySha = new Map<string, string[]>();
  let declared = 0;
  for (const [ref, a] of Object.entries(assets)) {
    const at = (field: string) => ({ file: F, pointer: `/assets/${escapePointer(ref)}${field}`, subject: ref });
    if (a.kind !== 'embedded') {
      if (isReservedPath(a.path)) { sink.add('ASSET_PATH_RESERVED', 'the .clearcase/ area is reserved for the application', at('/path')); continue; }
      const same = byPath.get(a.path);
      const fk = foldPath(a.path);
      if (same !== undefined) sink.add('ASSET_SHARED_PATH', `same original as ${same}`, at('/path'));
      else if (byFold.has(fk)) sink.add('ASSET_AMBIGUOUS_MAPPING', `path collides with the path of ${byFold.get(fk)} after case/NFC folding`, at('/path'));
      else { byPath.set(a.path, ref); byFold.set(fk, ref); }
    }
    if (a.kind === 'embedded' && ref !== `${a.parentRef}.a${a.ordinal}`) sink.add('ID_REF_INVALID', 'an embedded asset key must be <parentRef>.a<ordinal>', at(''));
    if (a.kind === 'missing') sink.add('ASSET_MISSING_AT_BUILD', 'the converter found no original for this document', at('/path'));
    if (a.kind === 'file') {
      if (!isPathKey(ref)) bySha.set(a.sha256, [...(bySha.get(a.sha256) ?? []), ref]);
      if (a.size > L.originalBytes) sink.add('ASSET_TOO_LARGE', `declared size ${a.size} exceeds ${L.originalBytes} bytes`, at('/size'));
      if (byPath.get(a.path) === ref) declared += a.size;
    }
    if (a.parentRef !== undefined) {
      const parent = assets[a.parentRef];
      if (!parent) sink.add('ASSET_PARENT_UNKNOWN', `parent ${a.parentRef} is not in the asset index`, at('/parentRef'));
      else {
        let cur: string | undefined = a.parentRef;
        const seen = new Set([ref]);
        let depth = 0;
        while (cur !== undefined) {
          if (seen.has(cur) || ++depth > L.parentDepth) { sink.add('ASSET_PARENT_CYCLE', 'parent chain cycles or is too deep', at('/parentRef')); break; }
          seen.add(cur);
          cur = assets[cur]?.parentRef;
        }
        if (!isContainer(parent.mediaType)) sink.add('ASSET_PARENT_NOT_CONTAINER', `parent media ${parent.mediaType} is not a container`, at('/parentRef'));
      }
    } else if (!register.has(ref) && !isPathKey(ref)) sink.add('ASSET_ORPHAN', 'asset has neither a document row nor a parent', at(''));
    const ts = a.textStatus as TextStatus;
    if (isPathKey(ref)) { if (!textStatusConsistent(a.mediaType, ts)) sink.add('TEXT_STATUS_INCONSISTENT', `textStatus ${ts} is impossible for ${a.mediaType} (capability ${capabilityOf(a.mediaType)})`, at('/textStatus')); continue; }
    if (!textStatusConsistent(a.mediaType, ts)) sink.add('TEXT_STATUS_INCONSISTENT', `textStatus ${ts} is impossible for ${a.mediaType} (capability ${capabilityOf(a.mediaType)})`, at('/textStatus'));
    else if (ts === 'unsupported') sink.add('MEDIA_UNSUPPORTED', `no text extractor for ${a.mediaType}; open or download only`, at('/mediaType'));
    else if (ts === 'none') sink.add('TEXT_NONE', `${a.mediaType} yielded no text`, at('/textStatus'));
    else if (ts === 'pending') sink.add('TEXT_PENDING', 'text extraction pending', at('/textStatus'));
  }
  if (declared > L.originalsTotalBytes) sink.add('ORIG_TOTAL_TOO_LARGE', `declared originals total ${declared} bytes, above ${L.originalsTotalBytes}`, { file: F });
  for (const ref of register) if (!assets[ref]) sink.add('ASSET_NOT_INDEXED', 'document has no asset entry and cannot be opened', { file: F, subject: ref });
  for (const [sha, refs] of bySha) if (refs.length > 1) sink.add('ASSET_DUPLICATE_CONTENT', `${refs.length} refs share one sha256`, { file: F, subject: sha.slice(0, 16) });
}


interface ScanContext { sink: DiagSink; file: string; targets: Set<string>; citations: CitationHit[]; check: () => void }

const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\ufff9-\ufffb]/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return true;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const short = (s: string): string => sha256Hex(s).slice(0, 12);

const ENTITIES: Record<string, string> = { colon: ':', sol: '/', bsol: '\\', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", tab: '\t', newline: '\n', lpar: '(', rpar: ')', period: '.', num: '#', percnt: '%', excl: '!', quest: '?', equals: '=', semi: ';', comma: ',', nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{1,10});?/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function markdownLinkTargets(s: string): string[] {
  const out: string[] = [];
  const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const push = (from: number, to: number, decode: (d: string) => string) => {
    out.push(to - from > MAX_LINK ? s.slice(from, from + MAX_LINK + 1) : decode(s.slice(from, to)));
  };
  const closing = (ch: string, from: number): number => {
    let k = from;
    while (k < s.length && k - from <= MAX_LINK && s[k] !== ch) k++;
    return k;
  };
  const take = (from: number): number => {
    let i = from;
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '\r' && s[i + 1] === '\n') i += 2; else if (s[i] === '\n' || s[i] === '\r') i++;
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '<') {
      const end = closing('>', i + 1);
      push(i + 1, end, unescapeDest);
      return end;
    }
    let end = i;
    while (end < s.length && end - i <= MAX_LINK && !isSpace(s[end]) && s[end] !== ')') end++;
    if (end > i) push(i, end, unescapeDest);
    return end;
  };
  for (let i = s.indexOf(']('); i >= 0; ) i = s.indexOf('](', Math.max(i + 2, take(i + 2)));
  // reference definitions: "[label]: dest" only where the label opens a line (at most 3 spaces of indent)
  for (let i = s.indexOf(']:'); i >= 0; ) {
    const lineStart = s.lastIndexOf('\n', i) + 1;
    const isDefinition = i - lineStart <= 1003 && /^ {0,3}\[(?:[^\[\]\\]|\\.){1,999}\]$/.test(s.slice(lineStart, i + 1));
    i = s.indexOf(']:', isDefinition ? Math.max(i + 2, take(i + 2)) : i + 2);
  }
  for (let i = s.indexOf('<'); i >= 0; ) {
    let j = i + 1;
    while (j < s.length && j - i <= 33 && /[A-Za-z0-9+.\-]/.test(s[j]!)) j++;
    let next = i + 1;
    if (s[j] === ':' && j > i + 1 && /[A-Za-z]/.test(s[i + 1]!)) {
      const end = closing('>', j);
      push(i + 1, end, decodeEntities);
      next = end;
    }
    i = s.indexOf('<', next);
  }
  return out;
}

const unescapeDest = (d: string): string => decodeEntities(d.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'));

const arrayIds = new WeakMap<unknown[], string[]>();
/** The stable id of each array element in diagnostic fingerprints: `<idField>:<value>` when the element names itself, else `#` plus the short hash of its text (`~n` for repeats). */
export function elementIds(arr: unknown[], idField: string | null): string[] {
  let ids = arrayIds.get(arr);
  if (!ids) {
    const seen = new Map<string, number>();
    ids = arr.map((el) => {
      if (idField && isObject(el) && typeof el[idField] === 'string' && el[idField] !== '') return `${idField}:${el[idField]}`;
      const d = short(textOf(el));
      const n = (seen.get(d) ?? 0) + 1;
      seen.set(d, n);
      return n === 1 ? `#${d}` : `#${d}~${n}`;
    });
    arrayIds.set(arr, ids);
  }
  return ids;
}

function scanDataset(env: DatasetEnvelope, ctx: ScanContext): void {
  const { sink, file } = ctx;
  const authored = env.kind === 'authored';
  const extra = EXTRA_CITATION_ARRAYS[env.schema];
  const nonCite = NON_CITATION_FIELDS[env.schema];
  const opaque = !KNOWN_SCHEMAS.has(env.schema);
  const path: string[] = [];
  const parents: unknown[] = [];
  let visited = 0;
  const ptr = () => '/data' + path.map((p) => '/' + escapePointer(p)).join('');
  const idField = (level: number) => (level === 0 && nonCite?.has('ref') ? 'ref' : null);
  const stable = () => '/data' + path.map((p, i) => '/' + (Array.isArray(parents[i]) ? elementIds(parents[i] as unknown[], idField(i))[Number(p)] : escapePointer(p))).join('');
  let here: { pointer: string; stablePointer: string } | null = null;
  const at = (subject: string) => {
    here ??= { pointer: ptr(), stablePointer: stable() };
    return { file, ...here, subject };
  };
  const cite = (ref: string, inline: boolean) => {
    const pointer = ptr();
    ctx.citations.push({ ref, file, pointer, inline });
    if (!ctx.targets.has(ref)) sink.add('CITE_UNRESOLVED', `citation target ${ref} is not in the document register`, at(ref));
  };
  const checkLink = (s: string, key: string) => {
    const c = classifyLink(s);
    if (c.kind === 'rejected') {
      if (c.scheme && c.scheme.length > 1) sink.add('LINK_UNSAFE_SCHEME', `${c.reason}`, at(c.scheme.slice(0, 20)));
      else sink.add('LINK_RELATIVE_UNSAFE', c.reason, at(key));
    } else if (c.kind === 'external') sink.add('LINK_EXTERNAL', 'external link (rendered inert, never fetched)', at(c.scheme));
    else if (c.kind === 'text-only') sink.add('LINK_TEXT_ONLY', c.reason, at(c.scheme.slice(0, 20)));
  };
  const visitString = (s: string, key: string | undefined, parentKey: string | undefined, inArray: boolean) => {
    if (++visited % 4096 === 0) ctx.check();
    here = null;
    let structured = false;
    if (!opaque) {
      if (!inArray && key !== undefined && nonCite?.has(key) && path.length === 2) structured = true;
      else if (!inArray && (key === 'ref' || key === 'headline_ref')) { structured = true; if (s !== '') cite(s, false); }
      else if (inArray && (parentKey === 'refs' || parentKey === 'also_in' || (parentKey !== undefined && extra?.has(parentKey)))) { structured = true; cite(s, false); }
      else if (!inArray && key === 'refs') { structured = true; for (const m of s.match(REF_IN_TEXT) ?? []) cite(m, false); }
    }
    const linkKey = inArray ? parentKey : key;
    if (linkKey !== undefined && LINK_FIELDS.has(linkKey)) checkLink(s, linkKey);
    if (authored && s.length > 0) {
      if (s.includes('[[')) {
        for (const m of s.matchAll(CITATION_TOKEN)) {
          const tok = parseCitationToken(m[1]!.trim());
          if (tok) cite(tok.ref, true);
          else sink.add('CITE_TOKEN_INVALID', 'malformed citation token; use [[REF]] or [[REF#pN]]', at(short(m[0])));
        }
      }
      if (!structured) {
        for (const m of s.replace(CITATION_TOKEN, ' ').match(REF_IN_TEXT) ?? []) sink.add('CITE_BARE_MENTION', `${m} is mentioned without a [[ ]] token and is not linked`, at(m));
      }
      for (const target of markdownLinkTargets(s)) checkLink(target, 'markdown-link');
    }
    if (BAD_TEXT.test(s)) sink.add('TEXT_CONTROL_CHARS', 'control or bidirectional characters (rendered visibly)', at(`${linkKey ?? ''}:${short(s)}`));
    if (linkKey !== undefined && /date$/i.test(linkKey) && !isCalendarDate(s)) sink.add('DS_DATE_INVALID', `${s.slice(0, 10)} is not a calendar date`, at(s.slice(0, 10)));
  };
  const walk = (v: unknown, key: string | undefined, parentKey: string | undefined, inArray: boolean) => {
    if (typeof v === 'string') return visitString(v, key, parentKey, inArray);
    if (Array.isArray(v)) {
      for (let k = 0; k < v.length; k++) { parents.push(v); path.push(String(k)); here = null; walk(v[k], undefined, key ?? parentKey, true); path.pop(); parents.pop(); here = null; }
      return;
    }
    if (isObject(v)) {
      const tpl: unknown = v;
      if (key !== undefined && LINK_FIELDS.has(key) && isViewTemplate(tpl)) { here = null; checkLink(templateLinkText(tpl), key); }
      for (const k of Object.keys(v)) {
        here = null;
        if (STORE_KEY.test(k)) sink.add('DS_USERWORK_EMBEDDED', 'a browser user-work store key is embedded in results', at(k.slice(0, 64)));
        if (BAD_TEXT.test(k)) sink.add('TEXT_CONTROL_CHARS', 'control or bidirectional characters in a key', at(`key:${short(k)}`));
        parents.push(v);
        path.push(k);
        here = null;
        walk(v[k], k, key, false);
        path.pop();
        parents.pop();
        here = null;
      }
    }
  };
  walk(env.data, undefined, undefined, false);
}

function storeKeysIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) storeKeysIn(x, out);
  else if (isObject(v)) for (const k of Object.keys(v)) { if (STORE_KEY.test(k)) out.push(k); storeKeysIn(v[k], out); }
  return out;
}


function checkMetaCounts(datasets: Map<string, DatasetEnvelope>, sink: DiagSink): void {
  const meta = datasets.get('meta');
  const chron = datasets.get('chronology');
  if (meta?.schema !== 'v5.meta@1' || chron?.schema !== 'v5.chronology@1' || !isObject(meta.data) || !Array.isArray(chron.data)) return;
  const M = meta.data;
  const rows = chron.data.filter(isObject);
  const by = (f: string) => { const c = new Map<string, number>(); for (const r of rows) { const v = textOf(r[f]); c.set(v, (c.get(v) ?? 0) + 1); } return c; };
  const status = by('text_status');
  const types = by('doc_type');
  const bundles = by('bundle');
  const people = datasets.get('people');
  const derived: [string | null, string, number][] = [
    [null, 'docCount', rows.length],
    [null, 'textNone', status.get('none') ?? 0],
    [null, 'textPending', status.get('pending') ?? 0],
    [null, 'emails', types.get('email') ?? 0],
    [null, 'invoices', types.get('invoice') ?? 0],
    ...(Array.isArray(people?.data) ? [[null, 'people', people.data.length] as [null, string, number]] : []),
  ];
  for (const [group, counts] of [['bundles', bundles], ['docTypes', types]] as const) {
    const m = Object.hasOwn(M, group) ? M[group] : undefined;
    if (!isObject(m)) continue;
    for (const k of new Set([...Object.keys(m), ...counts.keys()])) derived.push([group, k, counts.get(k) ?? 0]);
  }
  for (const [group, field, n] of derived) {
    const holder: JsonValue | undefined = group === null ? M : M[group];
    const raw = isObject(holder) && Object.hasOwn(holder, field) ? holder[field] : undefined;
    const name = group === null ? `META.${field}` : `META.${group}[${JSON.stringify(field)}]`;
    const at = { file: 'datasets/meta.json', pointer: '/data' + (group === null ? '' : `/${group}`) + '/' + escapePointer(field), subject: name.slice(0, 200) };
    if (typeof raw === 'number' && raw !== n) sink.add('V5_META_COUNT_DISAGREEMENT', `${name} is ${raw}; the records give ${n}. Displayed counts come from the records; META is kept unchanged.`, at);
    else if (raw === undefined && group !== null && n > 0) sink.add('V5_META_COUNT_DISAGREEMENT', `${name} is absent; the records give ${n}`, at);
  }
}

function checkSeeds(datasets: Map<string, DatasetEnvelope>, sink: DiagSink): void {
  for (const [key, def] of Object.entries(SEED_DATASETS)) {
    const env = datasets.get(key);
    if (!env || !KNOWN_SCHEMAS.has(env.schema)) continue;
    const rows = seedRows(env.data, def.pointer);
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      const id = def.keyFields.map((f) => textOf(r[f] ?? '')).join('\u0000');
      if (seen.has(id)) sink.add('DS_SEED_ID_AMBIGUOUS', 'two seed rows share the same natural key', { file: `datasets/${key}.json`, pointer: `/data${def.pointer}/${i}`, subject: short(id) });
      seen.add(id);
    });
  }
}

export function seedRows(data: unknown, pointer: string): JsonObject[] {
  let v: unknown = data;
  for (const seg of pointer.split('/').slice(1)) v = isObject(v) ? v[seg] : undefined;
  return Array.isArray(v) ? v.filter(isObject) : [];
}
