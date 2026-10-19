// CC-25 (GRS-24) acceptance item 3 on the real exports: every supported generation yields the same versioned
// results-package contract. For each package the GRS-22 probe wrote, it validates the written directory against the
// case folder, recomputes its identities, reconverts the source and compares every byte, maps each source row to its
// indexed and verified original (its locator and declared size must agree with the index, see ../mapping.ts), and
// checks the diagnostics against the code registry and every residual dataset against the coverage the converter and
// the validator report. Then it compares the generations' contracts.
// Prints and writes counts, codes, key names and states only, never a document value.
//
//   bun tests/acceptance/CC-25/real/contract.ts NAME=PKG_DIR=CASE_FOLDER=HTML ... (writes <dir of the first PKG_DIR>/contract.json)
//
// Exit 0 when every check holds, 1 otherwise.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CODES, type Code } from '../../../../src/lib/case-package/codes.ts';
import { importCandidate } from '../../../../src/lib/case-package/import.ts';
import { resultsVersionOf, sha256Hex } from '../../../../src/lib/case-package/hash.ts';
import { KNOWN_SCHEMAS, OPAQUE_SCHEMA, REQUIRED_DATASETS } from '../../../../src/lib/case-package/registry.ts';
import { decodeUtf8Strict, isObject, parseStrictJson, type JsonObject } from '../../../../src/lib/case-package/strict-json.ts';
import { convertV5 } from '../../../../src/lib/case-package/v5/adapter.ts';
import { DiagSink } from '../../../../src/lib/case-package/diagnostics.ts';
import { extractV5 } from '../../../../src/lib/case-package/v5/extract.ts';
import { verifyCandidateBytes } from '../../../../src/lib/case-package/verify-bytes.ts';
import { mapOriginals, type IndexedAsset } from '../mapping.ts';

type J = Record<string, any>;
const specs = process.argv.slice(2).map((s) => { const [name, pkg, caseFolder, html] = s.split('='); return { name: name!, pkg: path.resolve(pkg!), caseFolder: caseFolder!, html: html! }; });
if (!specs.length || specs.some((s) => !s.html)) { console.error('usage: contract.ts NAME=PKG_DIR=CASE_FOLDER=HTML ...'); process.exit(2); }
const tally = (xs: Iterable<string>) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return Object.fromEntries(Object.entries(c).sort()); };
const RESIDUAL_CODES = ['V5_UNMAPPED_KEY', 'V5_DATASET_SHAPE_UNMAPPED', 'V5_OVERLAY_UNMAPPED'];

const problems: string[] = [];
const out: J = { generations: {} };
const contracts: Record<string, Map<string, { schema: string; required: boolean; kind: string }>> = {};

for (const s of specs) {
  const fail = (m: string) => problems.push(`${s.name}: ${m}`);
  const html = new Uint8Array(await readFile(s.html));
  const src = extractV5(html, new DiagSink());
  if (!src) { fail('the source is not a supported generation'); continue; }

  // the written package, validated from its directory against the case folder (every original hashed)
  const res = await importCandidate(s.pkg, s.caseFolder, { concurrency: 4 });
  if (res.verdict === 'reject' || !res.candidate) { fail(`validation rejects the package: ${Object.keys(tally(res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)))}`); continue; }
  const c = res.candidate;
  const files = new Map([...c.snapshot()].map(({ path: p, bytes }) => [p, bytes]));
  const m = c.manifest as unknown as J;
  const json = (p: string) => parseStrictJson(decodeUtf8Strict(files.get(p)!)) as J;

  // the versioned contract
  if (m.format !== 'clearcase.results-package' || m.formatVersion !== 1) fail(`format ${m.format} ${m.formatVersion}`);
  if (m.inputRevision.kind !== 'v5-workspace-html') fail(`inputRevision.kind ${m.inputRevision.kind}`);
  const assetIndex = json('assets.json');
  if (assetIndex.index !== 'clearcase.assets/1') fail(`asset index ${assetIndex.index}`);
  const contract = new Map<string, { schema: string; required: boolean; kind: string }>();
  for (const f of m.files.filter((f: J) => f.role === 'dataset')) {
    const env = json(f.path);
    if (env.envelope !== 'clearcase.dataset/1' || env.key !== f.key || env.schema !== f.schema || env.required !== f.required || env.count !== f.count) fail(`${f.key}: envelope and manifest disagree`);
    if (f.schema !== OPAQUE_SCHEMA) {
      const def = KNOWN_SCHEMAS.get(f.schema);
      if (!def || def.key !== f.key || def.required !== f.required || def.kind !== f.kind) fail(`${f.key}: not the registry's dataset for ${f.schema}`);
      else if (!c.dataset(f.key)) fail(`${f.key}: the reader does not hold it`);
    } else if (f.required) fail(`${f.key}: an opaque dataset is required`);
    contract.set(f.key, { schema: f.schema, required: f.required, kind: f.kind });
  }
  for (const k of REQUIRED_DATASETS) if (!contract.has(k)) fail(`required dataset ${k} missing`);
  contracts[s.name] = contract;

  // identities: recomputed from the bytes, and reproduced byte for byte by a second conversion of the source
  const ident = verifyCandidateBytes(files, c.identity());
  if (!ident.ok) fail(`stored bytes do not verify: ${ident.problems.slice(0, 3).join('; ')}`);
  if (resultsVersionOf({ formatVersion: m.formatVersion, caseId: m.case.id, inputRevisionId: m.inputRevision.id, files: m.files }) !== c.resultsVersion) fail('resultsVersion does not recompute');
  const htmlSource = m.inputRevision.sources.find((x: J) => x.role === 'workspace-html' || x.sha256 === sha256Hex(html));
  if (!htmlSource || htmlSource.sha256 !== sha256Hex(html) || htmlSource.size !== html.byteLength) fail('inputRevision does not name the workspace HTML bytes');
  const again = await convertV5({ html, htmlName: path.basename(s.html), caseFolder: s.caseFolder, caseId: m.case.id, concurrency: 4 });
  const sameBytes = again.files !== null && again.files.size === files.size && [...files].every(([p, b]) => { const o = again.files!.get(p); return !!o && sha256Hex(o) === sha256Hex(b); });
  if (again.manifest?.resultsVersion !== c.resultsVersion || !sameBytes) fail('a second conversion of the same source gives another package');

  // document identity and original mappings: each source row, in order, to its ref, its indexed path and its verified original
  const rows: J[] = src.generation === 'json-script'
    ? ((parseStrictJson(/^\s*<script id="app-data" type="application\/json">(.*)<\/script>\s*$/m.exec(decodeUtf8Strict(html))![1]!) as J).chronology as J[])
    : ((src.roots.DATA as J).chronology as J[]);
  const chronology = json('datasets/chronology.json').data as J[];
  const sourceRefs = rows.map((r) => r.ref), packageRefs = chronology.map((r) => r.ref);
  if (JSON.stringify(sourceRefs) !== JSON.stringify(packageRefs)) fail('the register is not the source rows, in order');
  const assets = assetIndex.assets as Record<string, J>;
  const mapped = mapOriginals(
    rows.map((r) => ({ ref: r.ref, url: r.url, declaredSize: src.generation === 'json-script' ? r.sz : r.size })),
    assets as Record<string, IndexedAsset>,
    (ref) => c.original(ref) ?? undefined,
  );
  const mapping = mapped.mapping;
  for (const p of mapped.problems) fail(p);

  // diagnostics: every code registered at its severity; every residual dataset reported by the converter and the validator
  const unregistered = res.diagnostics.filter((d) => CODES[d.code as Code]?.severity !== d.severity).map((d) => d.code);
  const conv = (json('datasets/conversion-report.json').data as { diagnostics: { code: string; subject: string | null; message: string }[] }).diagnostics;
  const convUnregistered = conv.filter((d) => !(d.code in CODES)).map((d) => d.code);
  if (unregistered.length || convUnregistered.length) fail(`codes outside the registry or at another severity: ${[...new Set([...unregistered, ...convUnregistered])]}`);
  const residual = m.files.filter((f: J) => f.role === 'dataset' && f.schema === OPAQUE_SCHEMA).map((f: J) => ({ key: f.key as string, path: f.path as string, sourcePath: json(f.path).provenance.sourcePath as string }));
  const coverage = residual.map((r: { key: string; path: string; sourcePath: string }) => {
    const validator = res.diagnostics.some((d) => d.code === 'DS_UNKNOWN_SCHEMA' && d.file === r.path);
    // V5_UNMAPPED_KEY and V5_OVERLAY_UNMAPPED name the source path, V5_DATASET_SHAPE_UNMAPPED the demoted key
    const converter = conv.find((d) => RESIDUAL_CODES.includes(d.code) && (d.subject === r.sourcePath || `v5-residual-${d.subject}` === r.key))?.code ?? null;
    return { key: r.key, sourcePath: r.sourcePath, validator, converter };
  });
  for (const x of coverage) if (!x.validator || !x.converter) fail(`${x.key}: residual without ${!x.validator ? 'DS_UNKNOWN_SCHEMA' : 'a converter diagnostic'}`);

  out.generations[s.name] = {
    generation: src.generation, verdict: res.verdict, resultsVersion: c.resultsVersion, files: files.size, bytes: [...files.values()].reduce((n, b) => n + b.byteLength, 0),
    datasets: { recognized: [...contract.values()].filter((d) => d.schema !== OPAQUE_SCHEMA).length, residual: residual.length },
    identity: { bytesVerify: ident.ok, reconvertSameBytes: sameBytes }, mapping,
    validatorCodes: tally(res.diagnostics.map((d) => `${d.severity} ${d.code}`)), validatorTotals: res.counts,
    converterCodes: tally(conv.map((d) => d.code)), residualCoverage: coverage.map((x) => `${x.key} <- ${x.sourcePath}: ${x.converter} + ${x.validator ? 'DS_UNKNOWN_SCHEMA' : 'none'}`),
  };
  console.log(`${s.name}: ${src.generation} ${res.verdict}, ${contract.size} datasets (${residual.length} residual), ${mapping.rows} rows, ${mapping.verified} originals verified`);
}

// one contract: a dataset key two generations both write has the same schema, kind and required flag in each
const keys = new Set(Object.values(contracts).flatMap((c) => [...c.keys()]));
const shared: J = {};
for (const k of [...keys].sort()) {
  const seen = Object.entries(contracts).filter(([, c]) => c.has(k)).map(([g, c]) => [g, c.get(k)!] as const);
  const forms = new Set(seen.map(([, d]) => JSON.stringify(d)));
  if (forms.size > 1) problems.push(`${k}: written as ${[...forms].join(' and ')} by different generations`);
  shared[k] = seen.map(([g]) => g).join(',');
}
out.sharedKeys = tally(Object.values(shared) as string[]);
out.problems = problems;
await Bun.write(path.join(path.dirname(specs[0]!.pkg), 'contract.json'), JSON.stringify(out, null, 1));
console.log(problems.length ? `CONTRACT FAIL ${problems.length}: ${problems.join('; ')}` : `CONTRACT PASS ${specs.length} generations, ${keys.size} dataset keys, one contract`);
process.exit(problems.length ? 1 : 0);
