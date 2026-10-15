import { DiagSink } from '../diagnostics.ts';
import { pathAssetKey, sha256Hex } from '../hash.ts';
import { withLimits, type Limits } from '../limits.ts';
import { capabilityOf, mediaTypeForName, type TextStatus } from '../media.ts';
import { fingerprintOriginal, Interrupted, openCaseFolder } from '../originals.ts';
import { checkRelPath, decodeLegacyLocator, foldPath, isReservedPath } from '../paths.ts';
import { isRef } from '../refs.ts';
import Value from 'typebox/value';
import { CONVERSION_REPORT, LAYOUT, OPAQUE_SCHEMA, REQUIRED_DATASETS, V5_DATASETS, V5_SPLIT_PARENTS, VIEW_CONTENT } from '../registry.ts';
import type { Asset, Manifest } from '../schema.ts';
import { decodeUtf8Strict, isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import { buildPackage, type DatasetSpec } from '../writer.ts';
import { extractV5, V5_ROOTS, type V5Root, type V5Source } from './extract.ts';
import { mapNewerRoots } from './newer-workspace.ts';
import { extractViewContent, type FieldStatus, type ViewContentResult } from './view-content.ts';
import { VIEW_CONTENT_AUDIT, VIEW_CONTENT_MAP, VIEW_CONTENT_OMISSIONS } from './view-content-map.ts';
import type { Diagnostic } from '../codes.ts';

export const ADAPTER = { name: 'clearcase-v5-adapter', version: '0.1.0', mapping: 'clearcase-v5-adapter@0' };
export const V5_SOURCE = 'v5-workspace-html';

export interface ConvertOptions {
  html: Uint8Array;
  htmlName: string;
  caseFolder: string;
  caseId: string;
  caseLabel?: string;
  created?: string;
  concurrency?: number;
  limits?: Partial<Limits>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface ConvertResult {
  ok: boolean;
  manifest: Manifest | null;
  files: Map<string, Uint8Array> | null;
  diagnostics: Diagnostic[];
  source: V5Source | null;
  viewContent: { fields: FieldStatus[]; unmapped: ViewContentResult['unmapped'] } | null;
  stats: { datasets: number; chronology: number; assetsFile: number; assetsEmbedded: number; assetsMissing: number; residual: number; bytesHashed: number };
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'x';

export function splitSourcePath(p: string): [V5Root, string[]] {
  const root = V5_ROOTS.find((r) => p === r || p.startsWith(r + '.'));
  if (!root) throw new Error(`unknown source root in ${p}`);
  return [root, p === root ? [] : p.slice(root.length + 1).split('.')];
}

function getAt(roots: V5Source['roots'], p: string): JsonValue | undefined {
  const [root, segs] = splitSourcePath(p);
  let v: JsonValue | undefined = roots[root];
  for (const s of segs) v = isObject(v) && Object.hasOwn(v, s) ? v[s] : undefined;
  return v;
}

/** v5 text_status -> textStatus. v5 had no OCR stage, so "none" on image media means "no extractor". */
export function mapTextStatus(src: unknown, mediaType: string): TextStatus {
  const cap = capabilityOf(mediaType);
  switch (src) {
    case 'extracted': return cap === 'ocr' ? 'ocr' : cap === 'none' ? 'unsupported' : 'extracted';
    case 'ocr': return cap === 'text' || cap === 'ocr' ? 'ocr' : 'unsupported';
    case 'none': return cap === 'text' ? 'none' : 'unsupported';
    case 'pending': return 'pending';
    default: return 'pending';
  }
}

const arr = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);
const shapeMiss = (schema: unknown, v: unknown): string | undefined => {
  if (Value.Check(schema as never, v)) return undefined;
  const e = Value.Errors(schema as never, v)[Symbol.iterator]().next().value;
  return e ? `${e.instancePath || '/'} ${e.message}` : 'does not match';
};
const objs = (v: JsonValue | undefined): JsonObject[] => arr(v).filter(isObject);

export function packageLocators(bundles: JsonValue | undefined, sched: JsonValue | undefined, caselinesUrl?: JsonValue): string[] {
  // the CaseLines tab links the viewer code's own BUNDLE.url (view-content), which v5 spells apart from caselinesSrc
  const out: JsonValue[] = [caselinesUrl ?? null];
  if (isObject(bundles)) {
    out.push(bundles.caselinesSrc ?? null);
    for (const b of objs(bundles.list)) {
      out.push(b.file ?? null, b.indexFile ?? null);
      for (const r of objs(b.rows)) out.push(r.sliceUrl ?? null, ...objs(r.parts).map((p) => p.url ?? null));
    }
  }
  if (isObject(sched)) for (const m of ['discovery', 'supplementary']) for (const i of objs(sched[m])) out.push(...objs(i.files).map((f) => f.url ?? null));
  return out.filter((u): u is string => typeof u === 'string' && u !== '');
}

export async function convertV5(opts: ConvertOptions): Promise<ConvertResult> {
  const L = withLimits(opts.limits);
  const sink = new DiagSink(L.diagnosticsPerCode);
  const stats = { datasets: 0, chronology: 0, assetsFile: 0, assetsEmbedded: 0, assetsMissing: 0, residual: 0, bytesHashed: 0 };
  let viewContent: ConvertResult['viewContent'] = null;
  const fail = (): ConvertResult => ({ ok: false, manifest: null, files: null, diagnostics: sink.finish(), source: null, viewContent, stats });
  const src = extractV5(opts.html, sink);
  if (!src) return fail();
  const roots = src.generation === 'v5-js-newer' ? mapNewerRoots(src.roots) : src.roots;
  const DATA = roots.DATA as JsonObject;
  const META = (roots.META ?? {}) as JsonObject;
  const prov = (sourcePath: string) => ({ source: V5_SOURCE, sourcePath, adapter: ADAPTER.mapping });

  const datasets: DatasetSpec[] = [];
  const mapped = new Set<string>();
  const demoted: { d: (typeof V5_DATASETS)[number]; v: JsonValue; miss: string }[] = [];
  for (const d of V5_DATASETS) {
    const v = getAt(roots, d.sourcePath);
    if (v === undefined) continue;
    mapped.add(d.sourcePath);
    const miss = REQUIRED_DATASETS.includes(d.key) ? undefined : shapeMiss(d.data, v);
    if (miss !== undefined) demoted.push({ d, v, miss });
    else datasets.push({ key: d.key, kind: d.kind, schema: d.schema, required: d.required, provenance: prov(d.sourcePath), data: v });
  }
  const used = new Set(datasets.map((d) => d.key));
  const residualKey = (base: string, sourcePath: string): string => {
    let key = base.length <= 64 && !used.has(base) ? base : `${base.slice(0, 50).replace(/-+$/, '')}-${sha256Hex(sourcePath).slice(0, 12)}`;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 50).replace(/-+$/, '')}-${sha256Hex(sourcePath).slice(0, 8)}-${n}`;
    used.add(key);
    return key;
  };
  const residual = (sourcePath: string, v: JsonValue) => {
    const key = residualKey('v5-residual-' + kebab(sourcePath.replace(/^DATA\./, '').replace(/^window\./, '')), sourcePath);
    sink.add('V5_UNMAPPED_KEY', `${sourcePath} has no mapping; kept as the opaque dataset ${key}`, { file: 'input', subject: sourcePath });
    datasets.push({ key, kind: 'generated', schema: OPAQUE_SCHEMA, required: false, provenance: prov(sourcePath), data: v });
    stats.residual++;
  };
  for (const { d, v, miss } of demoted) {
    const key = residualKey(`v5-residual-${d.key}`, d.sourcePath);
    sink.add('V5_DATASET_SHAPE_UNMAPPED', `${d.sourcePath} does not match ${d.schema} (${miss}); kept as the opaque dataset ${key}, so its view shows the empty state`, { file: 'input', subject: d.key });
    datasets.push({ key, kind: 'generated', schema: OPAQUE_SCHEMA, required: false, provenance: prov(d.sourcePath), data: v });
    stats.residual++;
  }
  for (const k of Object.keys(DATA)) {
    const sp = `DATA.${k}`;
    if (mapped.has(sp)) continue;
    if ((V5_SPLIT_PARENTS as readonly string[]).includes(sp) && isObject(DATA[k])) {
      for (const sub of Object.keys(DATA[k] as JsonObject)) if (!mapped.has(`${sp}.${sub}`)) residual(`${sp}.${sub}`, (DATA[k] as JsonObject)[sub]!);
    } else residual(sp, DATA[k]!);
  }
  const layout: Record<string, string[]> = { roots: V5_ROOTS.filter((r) => roots[r] !== undefined), DATA: Object.keys(DATA) };
  for (const sp of V5_SPLIT_PARENTS) { const v = getAt(roots, sp); if (isObject(v)) layout[sp] = Object.keys(v); }
  datasets.push({ key: LAYOUT.key, kind: LAYOUT.kind, schema: LAYOUT.schema, required: LAYOUT.required, provenance: prov(LAYOUT.sourcePath), data: layout });

  const vc: ViewContentResult = src.generation === 'v5-js'
    ? extractViewContent(decodeUtf8Strict(src.html.bom ? opts.html.subarray(3) : opts.html), VIEW_CONTENT_MAP, VIEW_CONTENT_OMISSIONS, { skipLines: Object.values(src.lines).filter((n): n is number => n !== undefined), audit: VIEW_CONTENT_AUDIT, sink })
    : { data: {}, fields: [], unmapped: [] };
  viewContent = { fields: vc.fields, unmapped: vc.unmapped };
  datasets.push({ key: VIEW_CONTENT.key, kind: VIEW_CONTENT.kind, schema: VIEW_CONTENT.schema, required: VIEW_CONTENT.required, provenance: prov(VIEW_CONTENT.sourcePath), data: vc.data });

  const caseRoot = await openCaseFolder(opts.caseFolder, sink);
  if (!caseRoot) return fail();
  const chron = Array.isArray(DATA.chronology) ? (DATA.chronology as JsonValue[]) : [];
  stats.chronology = chron.length;
  const assets: Record<string, Asset> = Object.create(null);
  const jobs: { ref: string; path: string; mediaType: string; textStatus: TextStatus; claimed: unknown; parentRef?: string; packageFile?: true }[] = [];
  for (const r of chron) {
    if (!isObject(r) || !isRef(r.ref)) continue;
    const ref = r.ref;
    const url = typeof r.url === 'string' ? r.url : '';
    const d = decodeLegacyLocator(url);
    const p = d.ok ? d.path : url;
    if (!d.ok) sink.add('LINK_RELATIVE_UNSAFE', `chronology url for ${ref} is not a safe "./" locator (${d.reason})`, { file: 'input', subject: ref });
    const mediaType = mediaTypeForName(p);
    jobs.push({ ref, path: p, mediaType, textStatus: mapTextStatus(r.text_status, mediaType), claimed: r.size, ...(isRef(r.pr) && r.pr !== ref && { parentRef: r.pr }) });
    const atts = Array.isArray(r.attachments) ? r.attachments : [];
    atts.forEach((name, j) => {
      if (typeof name !== 'string' || !name) return;
      const mt = mediaTypeForName(name);
      assets[`${ref}.a${j + 1}`] = { kind: 'embedded', parentRef: ref, ordinal: j + 1, member: name, mediaType: mt, textStatus: capabilityOf(mt) === 'text' ? 'pending' : 'unsupported' };
      stats.assetsEmbedded++;
    });
  }
  const taken = new Set(jobs.map((j) => foldPath(j.path)));
  for (const u of packageLocators(DATA.bundles, roots['window.__SCHED__'], (vc.data.caselines_tab as JsonObject | undefined)?.url as JsonValue | undefined)) {
    const d = decodeLegacyLocator(u);
    if (!d.ok || d.directory || taken.has(foldPath(d.path))) continue;
    taken.add(foldPath(d.path));
    if (isReservedPath(d.path)) {
      sink.add('ORIG_MISSING', `the linked file for ${pathAssetKey(d.path)} is not served (reserved)`, { file: 'input', subject: pathAssetKey(d.path) });
      continue;
    }
    const mediaType = mediaTypeForName(d.path);
    jobs.push({ ref: pathAssetKey(d.path), path: d.path, mediaType, textStatus: capabilityOf(mediaType) === 'text' ? 'pending' : 'unsupported', claimed: undefined, packageFile: true });
  }
  const deadline = Date.now() + L.validationDeadlineMs;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      opts.onProgress?.(next, jobs.length);
      const j = jobs[next++]!;
      const pr = j.parentRef !== undefined ? { parentRef: j.parentRef } : {};
      type Fp = Awaited<ReturnType<typeof fingerprintOriginal>>;
      let fp: Fp;
      try {
        fp = checkRelPath(j.path).ok ? await fingerprintOriginal(caseRoot, j.path, { limits: L, signal: opts.signal, deadline, concurrency: 1 }) : { kind: 'escape' };
      } catch (e) {
        if (e instanceof Interrupted) throw e;
        fp = { kind: 'unreadable' };
      }
      if (j.packageFile && (fp.kind === 'not-file' || fp.kind === 'unreadable' || fp.kind === 'too-large' || fp.kind === 'reserved')) {
        sink.add('ORIG_MISSING', `the linked file for ${j.ref} is not served (${fp.kind})`, { file: 'input', subject: j.ref });
        if (fp.kind !== 'reserved') {
          assets[j.ref] = { kind: 'missing', path: j.path, mediaType: j.mediaType, textStatus: j.textStatus };
          stats.assetsMissing++;
        }
        continue;
      }
      if (fp.kind !== 'file' && fp.kind !== 'missing') {
        const code = fp.kind === 'escape' ? 'ORIG_ESCAPE' : fp.kind === 'reserved' ? 'ASSET_PATH_RESERVED' : fp.kind === 'not-file' ? 'ORIG_NOT_FILE' : fp.kind === 'too-large' ? 'ORIG_TOO_LARGE' : 'ORIG_UNREADABLE';
        sink.add(code, `the original for ${j.ref} is refused (${fp.kind})`, { file: 'input', subject: j.ref });
        continue;
      }
      if (fp.kind !== 'file') {
        assets[j.ref] = { kind: 'missing', path: j.path, mediaType: j.mediaType, textStatus: j.textStatus, ...pr };
        stats.assetsMissing++;
        continue;
      }
      stats.bytesHashed += fp.size;
      if (typeof j.claimed === 'number' && j.claimed !== fp.size) sink.add('V5_SIZE_CLAIM_MISMATCH', `source size ${j.claimed} differs from ${fp.size} on disk`, { file: 'input', subject: j.ref });
      assets[j.ref] = { kind: 'file', path: j.packageFile ? j.path : fp.rel, sha256: fp.sha256, size: fp.size, mediaType: j.mediaType, textStatus: j.textStatus, ...pr };
      stats.assetsFile++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    sink.add(e.code, e.code === 'IMPORT_DEADLINE' ? 'conversion did not finish within the deadline' : 'conversion cancelled');
    return fail();
  }
  const sortedAssets: Record<string, Asset> = Object.create(null);
  for (const k of Object.keys(assets).sort()) sortedAssets[k] = assets[k]!;

  const conv = sink.finish().map(({ code, subject, message }) => ({ code, subject: subject ?? null, message }));
  datasets.push({
    key: CONVERSION_REPORT.key, kind: CONVERSION_REPORT.kind, schema: CONVERSION_REPORT.schema, required: CONVERSION_REPORT.required, provenance: prov(CONVERSION_REPORT.sourcePath),
    data: { adapter: { name: ADAPTER.name, version: ADAPTER.mapping }, sourceLines: Object.fromEntries(Object.entries(src.lines).sort()), ignoredCodeLiterals: [...new Set(src.codeLiteralsSeen)].sort(), diagnostics: conv },
  });

  const builtAt = typeof META.builtAt === 'string' ? META.builtAt : null;
  const created = opts.created ?? (builtAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(builtAt) ? builtAt.replace(' ', 'T') : null);
  if (!created) {
    sink.add('V5_PAYLOAD_MISSING', 'META.builtAt (YYYY-MM-DD HH:MM) is missing; pass an explicit created time (the clock is never used)', { file: 'input', subject: 'META.builtAt' });
    return fail();
  }
  const { manifest, files } = buildPackage({
    caseId: opts.caseId,
    ...(opts.caseLabel !== undefined && { caseLabel: opts.caseLabel }),
    inputKind: V5_SOURCE,
    sources: [{ role: 'workspace-html', name: opts.htmlName.slice(0, 200), sha256: sha256Hex(opts.html), size: opts.html.byteLength }],
    claims: { builtAt, docCount: typeof META.docCount === 'number' ? META.docCount : null },
    producer: { name: ADAPTER.name, version: ADAPTER.version },
    created,
    datasets,
    assets: sortedAssets,
  });
  stats.datasets = datasets.length;
  if (sink.errors > 0) return fail();
  return { ok: true, manifest, files, diagnostics: sink.finish(), source: src, viewContent, stats };
}
