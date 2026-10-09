// v5 adapter: workspace HTML bytes (data only) + the operator's case folder -> package bytes.
// Every source value is preserved unchanged. Originals are located read-only inside the case
// folder and identified by sha256 + size; the real on-disk relative path is recorded.
// Output is deterministic: no clock, no absolute paths, no dependence on hashing order.
import { DiagSink } from '../diagnostics.ts';
import { sha256Hex } from '../hash.ts';
import { withLimits, type Limits } from '../limits.ts';
import { capabilityOf, mediaTypeForName, type TextStatus } from '../media.ts';
import { fingerprintOriginal, Interrupted, openCaseFolder } from '../originals.ts';
import { checkRelPath, decodeLegacyLocator } from '../paths.ts';
import { isRef } from '../refs.ts';
import { CONVERSION_REPORT, LAYOUT, OPAQUE_SCHEMA, V5_DATASETS, V5_SPLIT_PARENTS } from '../registry.ts';
import type { Asset, Manifest } from '../schema.ts';
import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';
import { buildPackage, type DatasetSpec } from '../writer.ts';
import { extractV5, V5_ROOTS, type V5Root, type V5Source } from './extract.ts';
import type { Diagnostic } from '../codes.ts';

/** Producer identity. Only the major mapping id enters dataset bytes, so a patch release keeps resultsVersion. */
export const ADAPTER = { name: 'clearcase-v5-adapter', version: '0.1.0', mapping: 'clearcase-v5-adapter@0' };
export const V5_SOURCE = 'v5-workspace-html';

export interface ConvertOptions {
  html: Uint8Array;
  /** provenance only; never part of an identity */
  htmlName: string;
  caseFolder: string;
  caseId: string;
  caseLabel?: string;
  /** default: META.builtAt; never the clock */
  created?: string;
  concurrency?: number;
  limits?: Partial<Limits>;
  signal?: AbortSignal;
}

export interface ConvertResult {
  ok: boolean;
  manifest: Manifest | null;
  files: Map<string, Uint8Array> | null;
  diagnostics: Diagnostic[];
  source: V5Source | null;
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

export async function convertV5(opts: ConvertOptions): Promise<ConvertResult> {
  const L = withLimits(opts.limits);
  const sink = new DiagSink(L.diagnosticsPerCode);
  const stats = { datasets: 0, chronology: 0, assetsFile: 0, assetsEmbedded: 0, assetsMissing: 0, residual: 0, bytesHashed: 0 };
  const fail = (): ConvertResult => ({ ok: false, manifest: null, files: null, diagnostics: sink.finish(), source: null, stats });
  const src = extractV5(opts.html, sink);
  if (!src) return fail();
  const roots = src.roots;
  const DATA = roots.DATA as JsonObject;
  const META = (roots.META ?? {}) as JsonObject;
  const prov = (sourcePath: string) => ({ source: V5_SOURCE, sourcePath, adapter: ADAPTER.mapping });

  // datasets: mapped, then residual (unknown keys are preserved, never dropped)
  const datasets: DatasetSpec[] = [];
  const mapped = new Set<string>();
  for (const d of V5_DATASETS) {
    const v = getAt(roots, d.sourcePath);
    if (v === undefined) continue;
    datasets.push({ key: d.key, kind: d.kind, schema: d.schema, required: d.required, provenance: prov(d.sourcePath), data: v });
    mapped.add(d.sourcePath);
  }
  const used = new Set(datasets.map((d) => d.key));
  const residual = (sourcePath: string, v: JsonValue) => {
    const base = 'v5-residual-' + kebab(sourcePath.replace(/^DATA\./, '').replace(/^window\./, ''));
    // distinct source keys can kebab to the same key or be truncated: disambiguate with a digest of the source path
    let key = base.length <= 64 && !used.has(base) ? base : `${base.slice(0, 50).replace(/-+$/, '')}-${sha256Hex(sourcePath).slice(0, 12)}`;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 50).replace(/-+$/, '')}-${sha256Hex(sourcePath).slice(0, 8)}-${n}`;
    used.add(key);
    sink.add('V5_UNMAPPED_KEY', `${sourcePath} has no mapping; kept as the opaque dataset ${key}`, { file: 'input', subject: sourcePath });
    datasets.push({ key, kind: 'generated', schema: OPAQUE_SCHEMA, required: false, provenance: prov(sourcePath), data: v });
    stats.residual++;
  };
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

  // asset index: originals by path + fingerprint; embedded attachments by parent
  const caseRoot = await openCaseFolder(opts.caseFolder, sink);
  if (!caseRoot) return fail();
  const chron = Array.isArray(DATA.chronology) ? (DATA.chronology as JsonValue[]) : [];
  stats.chronology = chron.length;
  const assets: Record<string, Asset> = Object.create(null);
  const jobs: { ref: string; path: string; mediaType: string; textStatus: TextStatus; claimed: unknown; parentRef?: string }[] = [];
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
  const deadline = Date.now() + L.validationDeadlineMs;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
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
      if (fp.kind !== 'file' && fp.kind !== 'missing') {
        // never downgrade a refused original to "missing": these are errors
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
      assets[j.ref] = { kind: 'file', path: fp.rel, sha256: fp.sha256, size: fp.size, mediaType: j.mediaType, textStatus: j.textStatus, ...pr };
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

  // conversion report: deterministic (no timings, no absolute paths), sorted
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
  return { ok: true, manifest, files, diagnostics: sink.finish(), source: src, stats };
}
