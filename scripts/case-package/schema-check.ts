#!/usr/bin/env bun
// Exercise the committed JSON Schemas with an independent JSON Schema 2020-12 validator
// (@cfworker/json-schema, exact dev pin) next to TypeBox: every file of a freshly emitted
// synthetic package must be accepted by both, and malformed examples for every schema must be
// rejected by both. Exit 0 only when every case agrees with the expectation.
import { Validator } from '@cfworker/json-schema';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Value from 'typebox/value';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { buildSynth } from '../../tests/case-package/fixtures/build.ts';
import { cleanup } from '../../tests/case-package/fixtures/synth.ts';
import { malform } from '../../tests/case-package/fixtures/malform.ts';
import { SCHEMA_DIR, schemaDocs } from './schemas.ts';

const root = path.resolve(import.meta.dirname, '../..');
const docs = schemaDocs();
const failures: string[] = [];
let accepted = 0;
let rejected = 0;

const loaded = new Map<string, { independent: Validator; typebox: object }>();
for (const d of docs) {
  const committed = parseStrictJson(await readFile(path.join(root, SCHEMA_DIR, d.file), 'utf8')) as Record<string, unknown>;
  if (committed.$schema !== 'https://json-schema.org/draft/2020-12/schema') failures.push(`${d.file}: $schema is not 2020-12`);
  loaded.set(d.file, { independent: new Validator(committed as never, '2020-12', false), typebox: committed });
}
const byTitle = (prefix: string) => docs.find((d) => d.file.startsWith(prefix))!.file;

function expect(file: string, value: unknown, valid: boolean, label: string): void {
  const v = loaded.get(file)!;
  const a = v.independent.validate(value as never).valid;
  const b = Value.Check(v.typebox as never, value);
  if (a !== valid || b !== valid) failures.push(`${label}: expected ${valid ? 'valid' : 'invalid'}; @cfworker/json-schema=${a}, typebox=${b}`);
  else if (valid) accepted++; else rejected++;
}

const clone = <T>(v: T): T => structuredClone(v);

// 1. a freshly emitted synthetic package is valid under every schema
const built = await buildSynth('schema-check');
try {
  const files = new Map([...built.files].map(([p, b]) => [p, parseStrictJson(decodeUtf8Strict(b)) as any]));
  const manifest = files.get('manifest.json');
  expect('manifest.schema.json', manifest, true, 'manifest.json');
  expect('assets.schema.json', files.get('assets.json'), true, 'assets.json');
  for (const d of docs.filter((x) => x.dataset)) {
    const env = files.get(`datasets/${d.dataset}.json`);
    if (!env) { failures.push(`synthetic package lacks dataset ${d.dataset}`); continue; }
    expect('dataset-envelope.schema.json', env, true, `datasets/${d.dataset}.json envelope`);
    expect(d.file, env.data, true, `datasets/${d.dataset}.json data`);
  }
  const ack = { acknowledgement: 'clearcase.acknowledgement/1', resultsVersion: manifest.resultsVersion, manifestSha256: 'a'.repeat(64), diagnosticsSha256: 'sha256:' + 'b'.repeat(64), validatorVersion: 'clearcase-case-package@0.1.0', warningFingerprints: ['c'.repeat(32)] };
  expect('acknowledgement.schema.json', ack, true, 'acknowledgement');

  // 2. malformed examples are rejected
  const m = (edit: (x: any) => void, label: string) => { const x = clone(manifest); edit(x); expect('manifest.schema.json', x, false, `manifest: ${label}`); };
  m((x) => { x.formatVersion = 2; }, 'formatVersion 2');
  m((x) => { x.formatVersion = '1'; }, 'formatVersion as a string');
  m((x) => { delete x.resultsVersion; }, 'resultsVersion missing');
  m((x) => { x.schemaVersion = '1.0'; }, 'unknown top-level field');
  m((x) => { x.extensions = { custom: 1 }; }, 'extension without x- prefix');
  m((x) => { x.files[0].sha256 = x.files[0].sha256.toUpperCase(); }, 'uppercase sha256');
  m((x) => { x.files[0].role = 'baseline'; }, 'unknown file role');
  m((x) => { x.case.id = 'Has Spaces'; }, 'case id grammar');
  m((x) => { x.created = '2001-05-06 07:08'; }, 'created without T');
  m((x) => { x.inputRevision.sources = []; }, 'no input sources');
  const env0 = files.get('datasets/chronology.json');
  const e = (edit: (x: any) => void, label: string) => { const x = clone(env0); edit(x); expect('dataset-envelope.schema.json', x, false, `envelope: ${label}`); };
  e((x) => { delete x.required; }, 'required flag missing');
  e((x) => { x.count = -1; }, 'negative count');
  e((x) => { x.kind = 'user'; }, 'unknown kind');
  e((x) => { x.schema = 'chronology'; }, 'schema without @major');
  e((x) => { x.key = 'Chronology'; }, 'uppercase key');
  const assets0 = files.get('assets.json');
  const as = (edit: (x: any) => void, label: string) => { const x = clone(assets0); edit(x); expect('assets.schema.json', x, false, `assets: ${label}`); };
  as((x) => { x.assets['od-9'] = x.assets['OD-001']; }, 'lowercase key');
  as((x) => { x.assets['OD-001'].kind = 'link'; }, 'unknown asset kind');
  as((x) => { delete x.assets['OD-001'].sha256; }, 'file asset without sha256');
  as((x) => { x.assets['EM-0001.a1'].ordinal = 0; }, 'ordinal 0');
  as((x) => { x.assets['OD-001'].textStatus = 'done'; }, 'unknown textStatus');
  expect('acknowledgement.schema.json', { ...ack, warningFingerprints: ['short'] }, false, 'acknowledgement: short fingerprint');
  expect('acknowledgement.schema.json', { ...ack, diagnosticsSha256: 'b'.repeat(64) }, false, 'acknowledgement: digest without prefix');

  // one malformed record (or member) per recognized dataset, chosen from its schema
  for (const d of docs.filter((x) => x.dataset)) {
    const bad = malform(d.schema, files.get(`datasets/${d.dataset}.json`).data);
    if (bad === undefined) { failures.push(`${d.file}: no malformed example could be derived`); continue; }
    expect(d.file, bad, false, `${d.dataset}: malformed record`);
  }
  const chron = clone(files.get('datasets/chronology.json').data);
  chron[0].date = '03/02/2001';
  expect(byTitle('data.v5.chronology'), chron, false, 'chronology: non-ISO date');
  const chron2 = clone(files.get('datasets/chronology.json').data);
  chron2[1].amount = '1,150.00';
  expect(byTitle('data.v5.chronology'), chron2, false, 'chronology: amount with separators');
  const cl = clone(files.get('datasets/caselines-index.json').data);
  cl.index[0] = ['1', 'text'];
  expect(byTitle('data.v5.caselines-index'), cl, false, 'caselines-index: page number as text');
  const vc = files.get('datasets/view-content.json').data;
  const v = (edit: (x: any) => void, label: string) => { const x = clone(vc); edit(x); expect(byTitle('data.v5.view-content'), x, false, `view-content: ${label}`); };
  v((x) => { x['Bad View'] = {}; }, 'view id grammar');
  v((x) => { x.overview['bad-field'] = 'x'; }, 'field id grammar');
  v((x) => { x.overview.subtitle = true; }, 'boolean value');
  v((x) => { x.vdm_matrix_tab.columns = ['a', 1]; }, 'list with a number');
  v((x) => { x.timeline.synopsis = { template: [] }; }, 'empty template');
  v((x) => { x.timeline.synopsis = { template: ['a', { param: 'Not Valid' }] }; }, 'param name grammar');
} finally {
  await cleanup(built.root);
}

const total = accepted + rejected + failures.length;
if (failures.length) {
  console.error(`schema check: FAIL (${failures.length} of ${total} cases)\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`schema check: PASS ${docs.length} schemas; ${accepted} emitted files accepted and ${rejected} malformed examples rejected by both @cfworker/json-schema (JSON Schema 2020-12) and TypeBox`);
