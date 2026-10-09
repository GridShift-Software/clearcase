#!/usr/bin/env bun
// Export the TypeBox schemas as canonical JSON Schema 2020-12 files under src/lib/case-package/schema/.
// --check: exit 1 when a committed file is missing, stale or extra (nothing is written).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalText } from '../../src/lib/case-package/canonical.ts';
import { SCHEMA_DIR, schemaDocs } from './schemas.ts';

const check = process.argv.includes('--check');
const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, SCHEMA_DIR);
const docs = schemaDocs();
const problems: string[] = [];
if (!check) await mkdir(dir, { recursive: true });
for (const d of docs) {
  const text = canonicalText(d.schema);
  const p = path.join(dir, d.file);
  if (check) {
    const cur = await readFile(p, 'utf8').catch(() => null);
    if (cur === null) problems.push(`missing ${d.file}`);
    else if (cur !== text) problems.push(`stale ${d.file}`);
  } else await writeFile(p, text);
}
const expected = new Set(docs.map((d) => d.file));
for (const f of await readdir(dir).catch(() => [] as string[])) if (f.endsWith('.json') && !expected.has(f)) problems.push(`extra ${f}`);
if (problems.length) {
  console.error(`schema export: FAIL\n  ${problems.join('\n  ')}\nRun: bun scripts/case-package/export-schemas.ts`);
  process.exit(1);
}
console.log(`schema export: ${check ? 'PASS' : 'wrote'} ${docs.length} schemas in ${SCHEMA_DIR}`);
