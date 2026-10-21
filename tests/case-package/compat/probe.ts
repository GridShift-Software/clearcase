// GRS-22 compatibility probe for a real export kept under .local/ (never committed). It converts and validates the
// workspace HTML in memory, counts the source inventory, accounts for every top-level source dataset and compares the
// result with the inventory recorded in docs/compatibility.md. It prints counts, key names and states only: never a
// document value, name, date or amount. Run it through scripts/agent-tools/receipt; the receipt is the evidence.
//
//   bun tests/case-package/compat/probe.ts --html FILE --case-folder DIR --case-id ID [--expect NAME] [--out DIR] [--compare-with PKG_DIR]
//
// Exit 0: the inventory matches and nothing is unaccounted. 1: a mismatch or an unaccounted dataset. 2: usage.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DiagSink } from '../../../src/lib/case-package/diagnostics.ts';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { isRef } from '../../../src/lib/case-package/refs.ts';
import { decodeUtf8Strict, isObject, parseStrictJson, type JsonObject, type JsonValue } from '../../../src/lib/case-package/strict-json.ts';
import { matchAnchor } from '../../../src/lib/case-package/user-work.ts';
import { convertV5 } from '../../../src/lib/case-package/v5/adapter.ts';
import { mergeAnalysis, readAnalysisOverlay } from '../../../src/lib/case-package/v5/analysis-overlay.ts';
import { extractV5 } from '../../../src/lib/case-package/v5/extract.ts';
import { writePackageDir } from '../../../src/lib/case-package/writer.ts';
import { accountFor, packageDatasets, sourceKeys } from './account.ts';

const { values: a } = parseArgs({ options: { html: { type: 'string' }, 'case-folder': { type: 'string' }, 'case-id': { type: 'string' }, expect: { type: 'string' }, out: { type: 'string' }, 'compare-with': { type: 'string' } } });
if (!a.html || !a['case-folder'] || !a['case-id']) { console.error('usage: probe.ts --html FILE --case-folder DIR --case-id ID [--expect NAME] [--out DIR] [--compare-with PKG_DIR]'); process.exit(2); }

const TEXT_CAP = 4000;
const objs = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const size = (v: JsonValue | undefined): number => (Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : 0);
const tally = (xs: Iterable<string>) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return Object.fromEntries(Object.entries(c).sort()); };
const json = (files: ReadonlyMap<string, Uint8Array>, p: string) => JSON.parse(new TextDecoder().decode(files.get(p)!)) as JsonObject;

const html = new Uint8Array(await readFile(a.html));
const src = extractV5(html, new DiagSink());
if (!src) { console.log(JSON.stringify({ generation: null, refused: true })); process.exit(1); }

// the source inventory, read from the source itself
const inventory: JsonObject = { generation: src.generation };
let keys: Map<string, JsonValue>;
if (src.generation === 'json-script') {
  const script = (id: string): JsonObject => { const m = new RegExp(`^\\s*<script id="${id}" type="application/json">(.*)</script>\\s*$`, 'm').exec(new TextDecoder().decode(html)); return m ? (parseStrictJson(m[1]!) as JsonObject) : {}; };
  const appData = script('app-data'), appSeed = script('app-seed');
  const rows = objs(appData.chronology);
  keys = sourceKeys('json-script', { appData, appSeed });
  Object.assign(inventory, {
    chronologyRows: rows.length, appDataKeys: Object.keys(appData).length, appSeedKeys: Object.keys(appSeed).length,
    bundleGroups: size(isObject(appData.meta) ? appData.meta.bundles : undefined), courtBundles: size(isObject(appData.bundles) ? appData.bundles.list : undefined),
    matters: objs(appSeed.matters).length, storylineEntries: objs(appSeed.matters).reduce((n, m) => n + size(m.storyline), 0),
    risks: objs(appSeed.risk).length, risksWithOwner: objs(appSeed.risk).filter((r) => typeof r.owner === 'string' && r.owner !== '').length, risksWithType: objs(appSeed.risk).filter((r) => typeof r.type === 'string' && r.type !== '').length,
    rowsShortened: rows.filter((r) => r.sh === 1 || r.sh === true).length, rowsWithDateSource: rows.filter((r) => typeof r.ds === 'string' && r.ds !== '').length,
    rowsWithParent: rows.filter((r) => typeof r.pr === 'string' && r.pr !== '').length, positionTypes: tally(rows.map((r) => typeof r.n)),
  });
} else {
  const DATA = src.roots.DATA as JsonObject, META = (src.roots.META ?? {}) as JsonObject;
  const rows = objs(DATA.chronology);
  const text = isObject(DATA.text) ? Object.values(DATA.text).filter((t): t is string => typeof t === 'string') : [];
  keys = sourceKeys(src.generation, { DATA, META, sched: src.roots['window.__SCHED__'], caselines: src.roots['window.__CASELINES_IDX__'] });
  Object.assign(inventory, {
    chronologyRows: rows.length, dataKeys: Object.keys(DATA).length, auxiliaryRoots: ['window.__SCHED__', 'window.__CASELINES_IDX__'].filter((r) => src.roots[r as 'window.__SCHED__'] !== undefined).length,
    metaVersion: typeof META.version === 'string' ? META.version : null, bundleGroups: size(META.bundles), courtBundles: size(isObject(DATA.bundles) ? DATA.bundles.list : undefined),
    storylineEntries: size(isObject(DATA.matter) ? DATA.matter.storyline : undefined), profileKeys: size(DATA.profile), risks: size(DATA.riskMatrix),
    textEntries: text.length, textAtCap: text.filter((t) => t.length >= TEXT_CAP).length, rowsWithoutText: isObject(DATA.text) ? rows.filter((r) => !Object.hasOwn(DATA.text as JsonObject, String(r.ref))).length : null,
    rowsWithParent: rows.filter((r) => typeof r.pr === 'string' && r.pr !== '').length, positionTypes: tally(rows.map((r) => typeof r.n)),
    emails: isObject(DATA.emails) ? { rows: size(DATA.emails.rows), threads: size(DATA.emails.threads), gaps: size(DATA.emails.gaps) } : null,
  });
}

// the conversion and the full validation against the case folder
const t0 = performance.now();
const conv = await convertV5({ html, htmlName: path.basename(a.html), caseFolder: a['case-folder'], caseId: a['case-id'] });
const convertMs = Math.round(performance.now() - t0);
if (!conv.files) { console.log(JSON.stringify({ inventory, converted: false, errors: tally(conv.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)) })); process.exit(1); }
const t1 = performance.now();
const imported = await importCandidate({ files: conv.files }, a['case-folder']);
const validateMs = Math.round(performance.now() - t1);
if (a.out) await writePackageDir(a.out, conv.files);

const datasets = packageDatasets(conv.files);
// the newer viewer's hand-authored analysis (GRS-149): its roots and counts as the module holds them, and for each root
// the package datasets it reached through the module's merges, with their counts; keys and counts only
const analysis = src.generation === 'v5-js-newer' ? readAnalysisOverlay(decodeUtf8Strict(src.html.bom ? html.subarray(3) : html), new DiagSink()) : null;
inventory.analysisOverlay = analysis ? Object.fromEntries(Object.entries(analysis.X).map(([k, v]) => [k, size(v)] as const).sort(([x], [y]) => (x < y ? -1 : 1))) : null;
const analysisRead = analysis && (() => {
  const { rest, placed } = mergeAnalysis(src.roots, analysis);
  const under = (p: string, t: string) => p === t || p.startsWith(t + '.');
  return Object.fromEntries(Object.keys(analysis.X).sort().map((k) => {
    const m = placed.find((x) => x.key === k);
    const targets = !m ? [] : m.op === 'fields' ? (m.fields ?? []).map((f) => `${m.target}.${f}`) : [m.target];
    const held = datasets.filter((d) => targets.some((t) => under(d.sourcePath, t))).map((d) => [d.key, d.count] as const);
    if (Object.hasOwn(rest, k)) held.push(['v5-residual-analysis-overlay', size(rest[k])]);
    return [k, Object.fromEntries(held.sort(([x], [y]) => (x < y ? -1 : 1)))];
  }));
})();
const account = accountFor(src.generation, keys, datasets, new Set(conv.diagnostics.map((d) => d.subject ?? '')));
const assets = (json(conv.files, 'assets.json') as { assets: Record<string, JsonObject> }).assets;
const chronology = (json(conv.files, 'datasets/chronology.json') as { data: JsonObject[] }).data;
const people = (json(conv.files, 'datasets/people.json') as { data: JsonObject[] }).data;
const matter = conv.files.has('datasets/matter.json') ? (json(conv.files, 'datasets/matter.json') as { data: JsonObject }).data : {};
const risks = conv.files.has('datasets/risk-matrix.json') ? (json(conv.files, 'datasets/risk-matrix.json') as { data: JsonObject[] }).data : [];
const carry = (k: string) => risks.filter((r) => { const v = r[k]; return typeof v === 'string' ? v !== '' : Array.isArray(v) && v.length > 0; }).length;
const result: JsonObject = {
  verdict: imported.verdict, resultsVersion: conv.manifest!.resultsVersion, documents: chronology.length,
  datasets: datasets.length, residual: datasets.filter((d) => d.schema === 'opaque@1').length,
  demoted: conv.diagnostics.filter((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED').map((d) => d.subject ?? '').sort(),
  unmapped: conv.diagnostics.filter((d) => d.code === 'V5_UNMAPPED_KEY').map((d) => d.subject ?? '').sort(),
  states: tally(account.map((x) => x.state)), unaccounted: account.filter((x) => x.state === 'unaccounted').map((x) => x.source),
  assets: tally(Object.entries(assets).filter(([k]) => !k.startsWith('P-')).map(([, x]) => `${x.kind}${x.parentRef ? '+parent' : ''}`)),
  packageFiles: Object.keys(assets).filter((k) => k.startsWith('P-')).length,
  rowsDated: chronology.filter((r) => typeof r.date === 'string' && r.date !== '').length, rowsWithDateSource: chronology.filter((r) => typeof r.date_source === 'string').length,
  matterHeadings: { storyline: size(matter.storyline), strategy: size(matter.strategy) },
  peopleWithRole: people.filter((p) => typeof p.role === 'string' && p.role !== '').length,
  riskFields: { risks: risks.length, category: carry('category'), owner: carry('owner'), refs: carry('refs') },
  analysisRead: analysisRead ?? null,
  analysisOverlayNotice: conv.diagnostics.find((d) => d.code === 'V5_OVERLAY_UNMAPPED' || d.code === 'V5_OVERLAY_UNREADABLE')?.message ?? null,
  textCapNotice: conv.diagnostics.find((d) => d.code === 'V5_TEXT_CAPPED')?.message ?? null,
  conversionWarnings: tally(conv.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code)), validation: tally(imported.diagnostics.map((d) => d.code)),
  ms: { convert: convertMs, validate: validateMs }, rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
};
const out: JsonObject = { inventory, result, account: account.map((x) => ({ ...x })) as unknown as JsonValue };

if (a['compare-with']) {
  // a ref present in both packages but naming another original: an anchor made on the other package must never follow the ref
  const other = (JSON.parse(await readFile(path.join(a['compare-with'], 'assets.json'), 'utf8')) as { assets: Record<string, JsonObject> }).assets;
  const here = Object.entries(assets).filter(([k, x]) => isRef(k) && x.kind === 'file').map(([ref, x]) => ({ ref, sha256: String(x.sha256) }));
  const shared = Object.keys(other).filter((k) => isRef(k) && other[k]!.kind === 'file' && assets[k]?.kind === 'file');
  const changed = shared.filter((k) => other[k]!.sha256 !== assets[k]!.sha256);
  const outcome = changed.map((ref) => matchAnchor({ caseId: a['case-id']!, sha256: String(other[ref]!.sha256), refAtCreation: ref, resultsVersion: 'other' }, here));
  out.refReuse = {
    sharedRefs: shared.length, sameOriginal: shared.length - changed.length, changedOriginal: changed.length,
    anchorOutcome: tally(outcome.map((m) => m.status)), followedTheRef: outcome.filter((m, i) => m.status === 'exact' && m.ref === changed[i]).length,
  };
}

const failures: string[] = [...(result.unaccounted as string[]).map((s) => `unaccounted ${s}`)];
if (a.expect) {
  const doc = await readFile(path.join(import.meta.dirname, '../../../docs/compatibility.md'), 'utf8');
  const block = /```json compat-inventory\n([^]*?)\n```/.exec(doc);
  if (!block) { console.error('docs/compatibility.md has no compat-inventory block'); process.exit(2); }
  const want = (JSON.parse(block[1]!) as Record<string, JsonObject>)[a.expect];
  if (!want) { console.error(`no inventory named ${a.expect}`); process.exit(2); }
  const got: Record<string, JsonValue | undefined> = { ...inventory, verdict: result.verdict, documents: result.documents, unaccounted: result.unaccounted, demoted: result.demoted, refReuse: out.refReuse, riskFields: result.riskFields, textCapNotice: result.textCapNotice, analysisRead: result.analysisRead };
  for (const [k, v] of Object.entries(want)) if (JSON.stringify(got[k]) !== JSON.stringify(v)) failures.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
  out.expect = { name: a.expect, checked: Object.keys(want).length, failures };
}
console.log(JSON.stringify(out, null, 1));
console.log(failures.length ? `PROBE FAIL ${failures.length}: ${failures.join('; ')}` : `PROBE PASS ${src.generation} ${result.documents} documents, ${account.length} source datasets accounted for`);
process.exit(failures.length ? 1 : 0);
