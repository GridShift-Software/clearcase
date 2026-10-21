#!/usr/bin/env bun
// Executable verification of the package contract against the local v5 fixture: eleven lanes, each
// writing lane-NN.txt (counts and codes only, no case values) to --out. Exits 1 when any required
// lane fails or is skipped, 2 on a usage or configuration error.
//
//   bun run --bun verify:package -- --fixture-config .local/v5-verification.json --out DIR
//
// The fixture configuration is case-bearing and stays in ignored .local/. Lanes that change inputs
// work on in-memory package bytes or on a disposable reflink copy of the case folder under the work
// directory, never on the fixture's extracted folder. Nothing is written inside a case folder.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gitEnv } from '../browser-lock.mjs';
import { canonicalBytes, canonicalJson, canonicalText } from '../../src/lib/case-package/canonical.ts';
import { isPathKey } from '../../src/lib/case-package/refs.ts';
import type { ImportResult } from '../../src/lib/case-package/candidate.ts';
import { resultsVersionOf, sha256Hex } from '../../src/lib/case-package/hash.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { acceptedWarnings, acknowledge, canActivate } from '../../src/lib/case-package/policy.ts';
import { readCandidate } from '../../src/lib/case-package/reader.ts';
import { KNOWN_SCHEMAS, V5_DATASETS, VIEW_CONTENT } from '../../src/lib/case-package/registry.ts';
import { readViewContent } from '../../src/lib/case-package/view-content.ts';
import { VIEW_CONTENT_MAP } from '../../src/lib/case-package/v5/view-content-map.ts';
import { decodeLegacyLocator } from '../../src/lib/case-package/paths.ts';
import { parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { ADAPTER, convertV5, type ConvertResult } from '../../src/lib/case-package/v5/adapter.ts';
import { reassembleV5 } from '../../src/lib/case-package/v5/reassemble.ts';
import { writePackageDir } from '../../src/lib/case-package/writer.ts';
import { editManifestOnly, editPackage } from '../../tests/case-package/fixtures/build.ts';

interface Config {
  caseFolder: string;
  mainHtml: { path: string; sha256: string };
  bundlesOnlyHtml: { path: string; sha256: string };
  archive?: { path: string; sha256: string };
  references: { inventory: string; summary: string };
  caseId: string;
  workDir: string;
  /** the accepted GRS-10 identity of the main HTML conversion, before view-content existed */
  accepted?: { resultsVersion: string };
}

const { values } = parseArgs({ options: { 'fixture-config': { type: 'string' }, out: { type: 'string' }, lanes: { type: 'string' } }, strict: true });
if (!values['fixture-config'] || !values.out) { console.error('usage: verify-package.ts --fixture-config FILE --out DIR [--lanes 1,2,...]'); process.exit(2); }
const repo = path.resolve(import.meta.dirname, '../..');
const cfg = parseStrictJson(await readFile(values['fixture-config'], 'utf8')) as unknown as Config;
const out = path.resolve(values.out);
const work = path.resolve(repo, cfg.workDir);
// the work directory is deleted and rewritten: it must be a subfolder of the worktree's ignored .local/, never a case folder
const localReal = await realpath(path.join(repo, '.local')).catch(() => '');
if (localReal !== path.join(await realpath(repo), '.local') || !work.startsWith(path.join(repo, '.local') + path.sep) || path.resolve(cfg.caseFolder).startsWith(work) || work.startsWith(path.resolve(cfg.caseFolder) + path.sep)) {
  console.error('workDir must be a subfolder of .local/ in this worktree and must not overlap the case folder');
  process.exit(2);
}
await mkdir(out, { recursive: true });
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const git = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() }).stdout.trim();
const head = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const bunVersion = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim();
const pyVersion = spawnSync('python3', ['--version'], { encoding: 'utf8' }).stdout.trim();

class LaneFailure extends Error {}
type Log = (s: string) => void;
const lanes: { n: number; title: string; run: (log: Log) => Promise<void> }[] = [];
const lane = (n: number, title: string, run: (log: Log) => Promise<void>) => lanes.push({ n, title, run });
const check = (log: Log, ok: boolean, what: string) => { log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) throw new LaneFailure(what); };
const codes = (r: ImportResult) => new Set(r.diagnostics.map((d) => d.code));
const errorCodes = (r: ImportResult) => [...new Set(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))].sort().join(',');

// ---- shared setup ----------------------------------------------------------------------------
const tree = cfg.caseFolder;
const mainHtml = await readFile(cfg.mainHtml.path);
const variantHtml = await readFile(cfg.bundlesOnlyHtml.path);
const setupProblems: string[] = [];
if (sha256Hex(mainHtml) !== cfg.mainHtml.sha256) setupProblems.push('main HTML sha256 differs from the fixture locator');
if (sha256Hex(variantHtml) !== cfg.bundlesOnlyHtml.sha256) setupProblems.push('bundles-only HTML sha256 differs from the fixture locator');
const treeBefore = await treeStamp(tree);

const convert = (html: Uint8Array, name: string, caseFolder = tree, concurrency = 4) => convertV5({ html, htmlName: name, caseFolder, caseId: cfg.caseId, concurrency });
const main = await convert(mainHtml, path.basename(cfg.mainHtml.path));
const mainDir = path.join(work, 'pkg-main');
await writePackageDir(mainDir, main.files!);
const full = await importCandidate(mainDir, tree);

/** Cheap fingerprint of the fixture tree's top-level state (names, sizes, mtimes) to prove it is untouched. */
async function treeStamp(dir: string): Promise<string> {
  const p = spawnSync('find', [dir, '-printf', '%P|%s|%T@|%m\n'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return sha256Hex(p.stdout.split('\n').sort().join('\n'));
}

// ---- lanes ----------------------------------------------------------------------------------
lane(1, 'Convert v5 and compare all chronology fields; lossless canonical reassembly', async (log) => {
  check(log, main.ok && main.files !== null, `conversion ok (${main.files?.size} files, ${main.stats.chronology} documents, ${main.stats.assetsFile} originals fingerprinted, ${main.stats.assetsEmbedded} attachments)`);
  const refDir = path.join(work, 'reference');
  const py = spawnSync('python3', ['-I', path.join(repo, 'scripts/case-package/reference_v5.py'), cfg.mainHtml.path, refDir], { encoding: 'utf8' });
  check(log, py.status === 0, `independent reference extraction (GRS-9 reader, ${pyVersion}) exit ${py.status}`);
  const ref = async (root: string) => readFile(path.join(refDir, `${root}.json`), 'utf8');
  const refData = parseStrictJson(await ref('DATA')) as any;
  const pkgRows = full.candidate!.dataset('chronology')!.data as any[];
  const srcRows = refData.chronology as any[];
  let compared = 0, mismatches = 0, fieldSetDiff = 0;
  srcRows.forEach((row, i) => {
    const o = pkgRows[i] ?? {};
    if (Object.keys(o).sort().join() !== Object.keys(row).sort().join()) fieldSetDiff++;
    for (const k of Object.keys(row)) { compared++; if (canonicalJson(row[k]) !== canonicalJson(o[k])) mismatches++; }
  });
  check(log, srcRows.length === 1689 && pkgRows.length === 1689, `rows: reference ${srcRows.length}, package ${pkgRows.length}`);
  check(log, compared === 33780, `values compared: ${compared} (1,689 x 20)`);
  check(log, mismatches === 0 && fieldSetDiff === 0, `value mismatches: ${mismatches}; rows with a different field set: ${fieldSetDiff}`);
  const c = full.candidate!;
  const back = reassembleV5(c.datasetKeys().map((k) => c.dataset(k)!));
  for (const root of ['DATA', 'META', 'window.__SCHED__', 'window.__CASELINES_IDX__'] as const) {
    check(log, canonicalText(back[root]) === (await ref(root)), `lossless canonical reassembly of ${root} (TypeScript reassembly == Python reference bytes)`);
  }
  const inv = parseStrictJson(await readFile(cfg.references.inventory, 'utf8')) as any;
  const invByRef = new Map((inv.refs as any[]).map((r) => [r.ref, r]));
  let pathAgree = 0, sizeAgree = 0, urlAgree = 0;
  for (const row of pkgRows) {
    const a = c.assets[row.ref] as any;
    const d = decodeLegacyLocator(row.url);
    if (d.ok && a?.path === d.path) urlAgree++;
    if (a?.path === invByRef.get(row.ref)?.path) pathAgree++;
    if (a?.size === invByRef.get(row.ref)?.size) sizeAgree++;
  }
  check(log, urlAgree === 1689 && pathAgree === 1689 && sizeAgree === 1689, `asset path == decoded url: ${urlAgree}; == GRS-9 inventory path: ${pathAgree}; size == inventory size: ${sizeAgree}`);
  const files = c.paths().map((p) => path.join(mainDir, p));
  const pyc = spawnSync('python3', ['-I', path.join(repo, 'scripts/case-package/canonical.py'), '--check', ...files], { encoding: 'utf8' });
  check(log, pyc.status === 0, `Python reproduction of the file encoding: ${pyc.stdout.trim()}`);
});

lane(2, 'Validate a complete candidate with every recognized dataset validated', async (log) => {
  check(log, full.verdict === 'report' && full.candidate !== null, `verdict ${full.verdict}; candidate ${full.candidate ? 'present' : 'absent'}`);
  check(log, errorCodes(full) === '', `errors: ${errorCodes(full) || 'none'}`);
  const keys = full.candidate!.datasetKeys();
  const recognized = V5_DATASETS.map((d) => d.key);
  check(log, recognized.every((k) => keys.includes(k)), `all ${recognized.length} recognized v5 datasets present (${keys.length} datasets in total)`);
  check(log, keys.every((k) => KNOWN_SCHEMAS.has(full.candidate!.dataset(k)!.schema)), 'every dataset has a known schema and was shape-checked (no opaque or unknown schemas)');
  check(log, !codes(full).has('DS_SHAPE_INVALID') && !codes(full).has('DS_UNSUPPORTED_FIELD'), 'no shape errors and no unsupported fields');
  log(`counts: ${canonicalJson(full.counts)}`);
  log(`warning fingerprints: ${full.warningFingerprints.length}; diagnosticsSha256 ${full.diagnosticsSha256}`);
  const d = readCandidate(full.candidate!).derivedCounts();
  log(`derived: documents ${d.documents}, byTextStatus ${canonicalJson(d.byTextStatus)}, emails ${d.emails}, attachments ${d.attachments}`);
  check(log, d.documents === 1689 && d.attachments === 1308, 'derived document and attachment counts');
});

lane(3, 'Reject malformed data without a candidate', async (log) => {
  const files = main.files!;
  const truncated = new Map(files);
  truncated.set('datasets/chronology.json', files.get('datasets/chronology.json')!.subarray(0, 1000));
  const r1 = await importCandidate({ files: truncated }, tree);
  check(log, r1.verdict === 'reject' && r1.candidate === null, `truncated dataset: verdict ${r1.verdict}, candidate ${r1.candidate}, errors ${errorCodes(r1)}`);
  const r2 = await importCandidate({ files: editPackage(files, 'datasets/chronology.json', (v) => { v.data[0].date = 12345; }) }, tree);
  check(log, r2.verdict === 'reject' && r2.candidate === null && codes(r2).has('DS_SHAPE_INVALID'), `retyped record: verdict ${r2.verdict}, errors ${errorCodes(r2)}`);
  const r3 = await importCandidate({ files: editPackage(files, 'datasets/quantum.json', (v) => { delete v.data.invoiceLedger; v.count -= 1; }) }, tree);
  check(log, r3.verdict === 'reject' && codes(r3).has('DS_SHAPE_INVALID'), `missing required member: errors ${errorCodes(r3)}`);
});

lane(4, 'Reject duplicate refs', async (log) => {
  const r = await importCandidate({ files: editPackage(main.files!, 'datasets/chronology.json', (v) => { v.data[1].ref = v.data[0].ref; }) }, tree);
  check(log, r.verdict === 'reject' && r.candidate === null && codes(r).has('ID_DUPLICATE'), `verdict ${r.verdict}, errors ${errorCodes(r)}`);
});

lane(5, 'Report broken citation targets; known after acknowledgement; META discrepancies', async (log) => {
  const cites = full.diagnostics.filter((d) => d.code === 'CITE_UNRESOLVED');
  const prefixes = canonicalJson(Object.fromEntries([...cites.reduce((m, d) => m.set(d.subject!.split('-')[0]!, (m.get(d.subject!.split('-')[0]!) ?? 0) + 1), new Map<string, number>())].sort()));
  check(log, full.counts.CITE_UNRESOLVED === 20 && cites.every((d) => d.file === 'datasets/bundles.json' && d.pointer!.startsWith('/data/catalogue/')), `CITE_UNRESOLVED ${full.counts.CITE_UNRESOLVED}, all in bundles.catalogue; prefixes ${prefixes}`);
  check(log, cites.every((d) => d.severity === 'warning' && d.baseline === 'new'), 'first import with an empty baseline: every citation warning is new');
  const first = canActivate(full, null, []);
  check(log, !first.ok && first.reasons[0]!.code === 'ACK_REQUIRED', `activation without acknowledgement refused: ${first.newWarnings.length} new warnings`);
  const ack = acknowledge(full, first.newWarnings);
  check(log, canActivate(full, ack, []).ok, 'activation allowed with a bound acknowledgement');
  const trusted = acceptedWarnings(full, ack, []);
  const again = await importCandidate({ files: (await convert(mainHtml, 'workspace.html')).files! }, tree, { trustedBaseline: trusted });
  const known = again.diagnostics.filter((d) => d.code === 'CITE_UNRESOLVED' && d.baseline === 'known').length;
  check(log, known === 20 && canActivate(again, null, trusted).ok, `reconverted import against the accepted baseline: ${known} citation warnings known, activation needs no new acknowledgement`);
  const meta = full.diagnostics.filter((d) => d.code === 'V5_META_COUNT_DISAGREEMENT');
  for (const m of meta) log(`  ${m.subject}: ${m.message.split('.').slice(0, 2).join('.')}`);
  check(log, meta.length === 2 && meta.some((m) => m.subject === 'META.textNone' && /237; the records give 255/.test(m.message)) && meta.some((m) => m.subject === 'META.emails' && /469; the records give 629/.test(m.message)), 'both META discrepancies reported as V5_META_COUNT_DISAGREEMENT');
  const src = readCandidate(full.candidate!).sourceMeta!;
  check(log, src.textNone === 237 && src.emails === 469, 'raw META preserved unchanged (textNone 237, emails 469)');
});

lane(6, 'Reject a path traversal asset', async (log) => {
  const ref = (full.candidate!.dataset('chronology')!.data as any[])[0].ref;
  for (const p of ['../outside.pdf', '/etc/passwd', 'C:/x.pdf', 'DISCOVERY A/../../x.pdf']) {
    const r = await importCandidate({ files: editPackage(main.files!, 'assets.json', (v) => { v.assets[ref].path = p; }) }, tree);
    check(log, r.verdict === 'reject' && r.candidate === null && codes(r).has('ASSET_PATH_TRAVERSAL'), `asset path ${JSON.stringify(p)}: errors ${errorCodes(r)}`);
  }
});

lane(7, 'Distinguish unsupported media from missing text', async (log) => {
  const rows = full.candidate!.dataset('chronology')!.data as any[];
  const none = rows.filter((r) => r.text_status === 'none');
  const byCode = (code: string) => full.diagnostics.filter((d) => d.code === code && d.file === 'assets.json');
  const textNone = new Set(byCode('TEXT_NONE').map((d) => d.subject!));
  const unsupported = new Set(byCode('MEDIA_UNSUPPORTED').map((d) => d.subject!));
  const noneAsUnsupported = none.filter((r) => unsupported.has(r.ref));
  const media = (refs: Iterable<string>) => canonicalJson([...refs].reduce((m: Record<string, number>, r) => { const t = (full.candidate!.assets[r] as any).mediaType; m[t] = (m[t] ?? 0) + 1; return m; }, {}));
  log(`source rows with text_status none: ${none.length}`);
  log(`TEXT_NONE (warning, extractor ran, no text): ${textNone.size} by media ${media(textNone)}`);
  log(`source none on media without an extractor -> MEDIA_UNSUPPORTED (info): ${noneAsUnsupported.length} by media ${media(noneAsUnsupported.map((r) => r.ref))}`);
  log(`MEDIA_UNSUPPORTED in total (documents and attachments): ${full.counts.MEDIA_UNSUPPORTED}`);
  check(log, textNone.size + noneAsUnsupported.length === none.length && [...textNone].every((r) => !unsupported.has(r!)), 'every source "none" row is exactly one of TEXT_NONE or MEDIA_UNSUPPORTED');
  check(log, byCode('TEXT_NONE')[0]?.severity === 'warning' && byCode('MEDIA_UNSUPPORTED')[0]?.severity === 'info', 'distinct codes and severities');
  check(log, noneAsUnsupported.every((r) => r.text_status === 'none'), 'source text_status values unchanged');
});

lane(8, 'Resolve an attachment to its parent', async (log) => {
  const rd = readCandidate(full.candidate!);
  const embedded = Object.entries(full.candidate!.assets).filter(([, a]) => a.kind === 'embedded').map(([k]) => k);
  const routes = embedded.map((k) => rd.resolveAttachment(k));
  const toParent = routes.filter((r) => r?.route === 'parent' && r.original.status === 'verified').length;
  check(log, embedded.length === 1308 && toParent === 1308, `${toParent} of ${embedded.length} attachments resolve to a verified parent original`);
});

lane(9, 'Reconvert with stable output identity', async (log) => {
  const rv = main.manifest!.resultsVersion;
  const again = await convert(mainHtml, path.basename(cfg.mainHtml.path), tree, 4);
  const same = [...main.files!].every(([p, b]) => again.files!.get(p) && sha256Hex(again.files!.get(p)!) === sha256Hex(b)) && again.files!.size === main.files!.size;
  check(log, same, `plain reconversion byte-identical for all ${main.files!.size} files`);
  const c1 = await convert(mainHtml, 'workspace.html', tree, 1);
  const c16 = await convert(mainHtml, 'workspace.html', tree, 16);
  check(log, c1.manifest!.resultsVersion === rv && c16.manifest!.resultsVersion === rv, 'same resultsVersion at concurrency 1 and 16');
  const renamed = path.join(work, 'renamed-workspace.html');
  await writeFile(renamed, mainHtml);
  const envDir = path.join(work, 'pkg-env');
  const sub = spawnSync(process.execPath, [path.join(repo, 'scripts/case-package/cli.ts'), 'convert', '--html', renamed, '--case-folder', tree, '--case-id', cfg.caseId, '--out', envDir, '--no-validate'], { env: { ...process.env, TZ: 'Pacific/Chatham', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }, encoding: 'utf8' });
  const envManifest = parseStrictJson(await readFile(path.join(envDir, 'manifest.json'), 'utf8')) as any;
  check(log, sub.status === 0 && envManifest.resultsVersion === rv, 'same resultsVersion with TZ=Pacific/Chatham, LANG=tr_TR.UTF-8, renamed HTML and a different output directory');
  check(log, envManifest.inputRevision.id === main.manifest!.inputRevision.id && sha256Hex(await readFile(path.join(envDir, 'manifest.json'))) !== sha256Hex(main.files!.get('manifest.json')!), 'renamed HTML keeps inputRevision.id; only the manifest provenance (and manifestSha256) changes');
  const saved = ADAPTER.version;
  (ADAPTER as { version: string }).version = '0.1.99';
  const patched = await convert(mainHtml, 'workspace.html', tree);
  (ADAPTER as { version: string }).version = saved;
  check(log, patched.manifest!.resultsVersion === rv, 'same resultsVersion after a producer patch release');
  // disposable reflink copy of the case folder (never hardlinks); writes go only into the copy. The copy takes default
  // modes (--no-preserve=mode), so it is writable when the case folder is read-only (files 0444); the source keeps its own.
  const copy = path.join(work, 'case-copy');
  const cp = spawnSync('cp', ['-r', '--reflink=auto', '--no-preserve=mode', tree, copy]);
  check(log, cp.status === 0, 'disposable reflink copy of the case folder');
  await writeFile(path.join(copy, 'unrelated file.txt'), 'not referenced');
  const unrelated = await convert(mainHtml, 'workspace.html', copy);
  check(log, unrelated.manifest!.resultsVersion === rv, 'same resultsVersion with an unrelated file in the case folder');
  const text = new TextDecoder().decode(mainHtml);
  const at = text.search(/"excerpt":"[A-Za-z]/) + '"excerpt":"'.length;
  const ch = text[at] === 'Q' ? 'R' : 'Q';
  const narrative = await convert(new TextEncoder().encode(text.slice(0, at) + ch + text.slice(at + 1)), 'workspace.html');
  check(log, narrative.ok && narrative.manifest!.resultsVersion !== rv, 'one changed narrative character gives a new resultsVersion');
  const rows = full.candidate!.dataset('chronology')!.data as any[];
  const target = full.candidate!.assets[rows[0].ref] as any;
  const p = path.join(copy, ...target.path.split('/'));
  const bytes = await readFile(p);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await writeFile(p, bytes);
  const changed = await convert(mainHtml, 'workspace.html', copy);
  check(log, changed.manifest!.resultsVersion !== rv && changed.manifest!.inputRevision.id === main.manifest!.inputRevision.id, 'one changed original byte gives a new resultsVersion (same inputRevision)');
  await rm(copy, { recursive: true, force: true });
  const variant: ConvertResult = await convert(variantHtml, path.basename(cfg.bundlesOnlyHtml.path));
  const va = parseStrictJson(new TextDecoder().decode(variant.files!.get('assets.json')!)) as any;
  const ma = full.candidate!.assets as any;
  const vrows = (parseStrictJson(new TextDecoder().decode(variant.files!.get('datasets/chronology.json')!)) as any).data as any[];
  const shared = vrows.filter((r) => ma[r.ref]);
  const sameSha = shared.filter((r) => va.assets[r.ref]?.sha256 && va.assets[r.ref].sha256 === ma[r.ref].sha256).length;
  check(log, variant.manifest!.resultsVersion !== rv && variant.manifest!.inputRevision.id !== main.manifest!.inputRevision.id, 'bundles-only variant: new inputRevision and resultsVersion');
  check(log, vrows.length === 1562 && shared.length === 1562 && sameSha === 1562, `bundles-only variant: ${vrows.length} documents, ${shared.length} refs shared with main, ${sameSha} on the same sha256`);
});

lane(10, 'Reject an unsupported package version', async (log) => {
  for (const [label, edit] of [['formatVersion 2', (m: any) => { m.formatVersion = 2; }], ['formatVersion "1"', (m: any) => { m.formatVersion = '1'; }], ['schemaVersion "1.0" only', (m: any) => { delete m.formatVersion; m.schemaVersion = '1.0'; }]] as const) {
    const r = await importCandidate({ files: editManifestOnly(main.files!, edit) }, tree);
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    check(log, r.verdict === 'reject' && r.candidate === null && errs.length === 1 && errs[0]!.code === 'VER_UNSUPPORTED', `${label}: one error ${errs.map((d) => d.code).join(',')}; hint: ${errs[0]?.hint}`);
  }
});

lane(11, 'Carry code-embedded view content as data; every other file, package files aside, keeps the accepted identity', async (log) => {
  const vc = main.viewContent!;
  const extracted = vc.fields.filter((f) => f.status === 'extracted');
  const perView = new Map<string, number>();
  for (const f of extracted) perView.set(f.view, (perView.get(f.view) ?? 0) + 1);
  for (const [v, n] of [...perView].sort()) log(`  ${v}: ${n} fields`);
  // the views the map names (v5 views and the shared shell), so a map change that adds a view needs no edit here
  const mapViews = new Set(VIEW_CONTENT_MAP.map((e) => e.view)).size;
  check(log, extracted.length === VIEW_CONTENT_MAP.length, `map fields extracted: ${extracted.length} of ${VIEW_CONTENT_MAP.length} from ${perView.size} views (${mapViews - 1} v5 views and the shell expected: ${perView.size === mapViews})`);
  check(log, perView.size === mapViews, `fields come from ${mapViews - 1} v5 views and the shared shell`);
  const conv = main.diagnostics.filter((d) => d.code.startsWith('V5_VIEW_CONTENT_'));
  check(log, conv.length === 0, `view-content conversion diagnostics: ${conv.length}`);
  log(`unmapped prose literals in audited scopes (locations in the convert report, reviewed as UI chrome): ${vc.unmapped.length}`);
  const env = full.candidate!.dataset(VIEW_CONTENT.key);
  check(log, !!env && env.schema === VIEW_CONTENT.schema && env.kind === 'generated' && env.required === false && env.provenance.sourcePath === '(view-code)', `dataset ${VIEW_CONTENT.key}: ${env?.schema}, ${env?.kind}, required ${env?.required}, source ${env?.provenance.sourcePath}`);
  check(log, full.diagnostics.filter((d) => d.file === `datasets/${VIEW_CONTENT.key}.json`).length === 0, 'validated against v5.view-content@1 with no diagnostics on its file');
  const rd = readViewContent(env!.data);
  const templates = rd.views().flatMap((v) => rd.fields(v).filter((f) => (rd.params(v, f) ?? []).length > 0));
  check(log, rd.views().length === mapViews && rd.views().reduce((n, v) => n + rd.fields(v).length, 0) === VIEW_CONTENT_MAP.length, `typed reader: ${rd.views().length} views, ${templates.length} templates with params`);
  // GRS-45 package files (P- keys) joined assets.json later: the asset index without them must be GRS-10's bytes
  const index = parseStrictJson(new TextDecoder().decode(main.files!.get('assets.json')!)) as { index: string; root: string; assets: Record<string, unknown> };
  const docAssets = Object.fromEntries(Object.entries(index.assets).filter(([k]) => !isPathKey(k)));
  const packageFiles = Object.keys(index.assets).length - Object.keys(docAssets).length;
  const baseAssets = canonicalBytes({ index: index.index, root: index.root, assets: docAssets });
  log(`package files in the asset index (GRS-45): ${packageFiles}`);
  const files = main.manifest!.files.filter((f) => f.path !== `datasets/${VIEW_CONTENT.key}.json`)
    .map((f) => (f.path === 'assets.json' ? { ...f, count: Object.keys(docAssets).length, sha256: sha256Hex(baseAssets), size: baseAssets.byteLength } : f));
  const without = resultsVersionOf({ formatVersion: main.manifest!.formatVersion, caseId: main.manifest!.case.id, inputRevisionId: main.manifest!.inputRevision.id, files });
  check(log, !!cfg.accepted, 'the fixture configuration names the accepted pre-view-content identity');
  check(log, without === cfg.accepted!.resultsVersion, `every other file byte-identical: the manifest without view-content and package files gives ${without} (accepted ${cfg.accepted!.resultsVersion}); with them: ${main.manifest!.resultsVersion}`);
});

// ---- run ------------------------------------------------------------------------------------
const only = values.lanes ? new Set(values.lanes.split(',').map(Number)) : null;
let failed = 0;
const summary: string[] = [];
for (const l of lanes) {
  const lines: string[] = [];
  const log: Log = (s) => lines.push(s);
  let status = 'PASS';
  if (only && !only.has(l.n)) status = 'SKIPPED';
  else if (setupProblems.length) { status = 'FAIL'; lines.push(...setupProblems); }
  else {
    try { await l.run(log); } catch (e) { status = 'FAIL'; if (!(e instanceof LaneFailure)) lines.push(`error: ${(e as Error).stack ?? e}`); }
  }
  if (status !== 'PASS') failed++;
  const header = [`lane ${String(l.n).padStart(2, '0')}: ${l.title}`, `status: ${status}`, `revision: ${head}${dirty ? ' (dirty working tree)' : ''}`, `bun: ${bunVersion} (${process.execPath})`, `fixture: main HTML sha256 ${cfg.mainHtml.sha256}; bundles-only sha256 ${cfg.bundlesOnlyHtml.sha256}${cfg.archive ? `; archive sha256 ${cfg.archive.sha256}` : ''}`, ''];
  await writeFile(path.join(out, `lane-${String(l.n).padStart(2, '0')}.txt`), header.concat(lines).join('\n') + '\n');
  summary.push(`lane ${String(l.n).padStart(2, '0')} ${status}  ${l.title}`);
  console.log(summary.at(-1));
}
const untouched = (await treeStamp(tree)) === treeBefore;
console.log(`fixture case folder unchanged: ${untouched}`);
if (!untouched) failed++;
await writeFile(path.join(out, 'verify-package-summary.txt'), [...summary, `fixture case folder unchanged: ${untouched}`, `revision ${head}${dirty ? ' (dirty)' : ''}`, ''].join('\n'));
await rm(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
