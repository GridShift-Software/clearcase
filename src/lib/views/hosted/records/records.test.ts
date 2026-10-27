import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateCorpus } from '../../../../../scripts/fixtures/synthetic/corpus.ts';
import { KNOWN_SCHEMAS } from '../../../case-package/registry.ts';
import { sha256Hex } from '../../../case-package/hash.ts';
import type { ManifestFile } from '../../../case-package/schema.ts';
import { renderRecords, recordsSectionState, verifyDatasetBytes } from './index.ts';

let root: string;
let pkg: string;
let files: ManifestFile[];
const context = { originalHref: (ref: string, page: number | null) => `/original/${ref}${page ? `?page=${page}` : ''}` };
type Shape = { properties?: Record<string, Shape>; patternProperties?: Record<string, Shape>; items?: Shape; anyOf?: Shape[] };
function leaves(schema: Shape, prefix = '/data'): string[] {
  if (schema.properties) return Object.entries(schema.properties).flatMap(([key, child]) => leaves(child, `${prefix}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  if (schema.patternProperties) return Object.values(schema.patternProperties).flatMap(child => leaves(child, `${prefix}/*`));
  if (schema.items) return leaves(schema.items, `${prefix}/*`);
  if (schema.anyOf) return schema.anyOf.flatMap(child => leaves(child, prefix));
  return [prefix];
}
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'records-test-'));
  pkg = process.env.RECORDS_POC_PACKAGE ?? path.join(root, 'corpus', 'pkg');
  if (!process.env.RECORDS_POC_PACKAGE) await generateCorpus({ out: path.join(root, 'corpus'), seed: 'records-test', documents: 24, profile: 'poc' });
  files = JSON.parse(await readFile(path.join(pkg, 'manifest.json'), 'utf8')).files;
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('source records', () => {
  it('renders every registered dataset in the poc package and detects a missing record marker', async () => {
    const entries = files.filter(f => f.role === 'dataset' && f.schema && KNOWN_SCHEMAS.has(f.schema));
    expect(entries.length).toBe(KNOWN_SCHEMAS.size);
    let mutated = false;
    for (const entry of entries) {
      const dataset = verifyDatasetBytes(entry, await readFile(path.join(pkg, entry.path)));
      const rendered = renderRecords(dataset, context);
      expect(rendered.html).toContain('Source records');
      expect(recordsSectionState(dataset, rendered), entry.key).toBe('records-rendered');
      const expectedLeaves = [...new Set(leaves(KNOWN_SCHEMAS.get(dataset.schemaId)!.data as Shape))].map(sha256Hex);
      expect(rendered.markers.leaves).toEqual(expectedLeaves);
      if (Array.isArray(dataset.value.data)) expect(rendered.markers.records.length).toBeGreaterThanOrEqual(dataset.value.data.length);
      for (const marker of rendered.markers.records) expect(rendered.html).toContain(`data-record="${marker}"`);
      for (const marker of expectedLeaves) expect(rendered.html).toContain(`data-leaf="${marker}"`);
      if (rendered.markers.records.length) {
        expect(recordsSectionState(dataset, { ...rendered, markers: { ...rendered.markers, records: rendered.markers.records.slice(1) } })).toBe('invalid');
        const marker = rendered.markers.records[0]!;
        expect(recordsSectionState(dataset, { ...rendered, html: rendered.html.replace(`data-record="${marker}"`, '') })).toBe('invalid');
        mutated = true;
      }
    }
    expect(mutated).toBe(true);
  }, 120_000);
  it('refuses altered bytes and invalid schema data', async () => {
    const entry = files.find(f => f.key === 'people')!;
    const bytes = await readFile(path.join(pkg, entry.path));
    expect(() => verifyDatasetBytes({ ...entry, sha256: '0'.repeat(64) }, bytes)).toThrow();
    expect(() => verifyDatasetBytes({ ...entry, size: entry.size + 1 }, bytes)).toThrow();
    const malformed = new TextEncoder().encode('{broken');
    expect(() => verifyDatasetBytes({ ...entry, size: malformed.length, sha256: sha256Hex(malformed) }, malformed)).toThrow();
    const value = JSON.parse(bytes.toString()); value.data = 'not an array';
    const bad = new TextEncoder().encode(JSON.stringify(value));
    expect(() => verifyDatasetBytes({ ...entry, size: bad.length, sha256: sha256Hex(bad) }, bad)).toThrow();
  });
  it('escapes hostile text and links citations through the injected route', async () => {
    const entry = files.find(f => f.key === 'matter')!;
    const value = JSON.parse(await readFile(path.join(pkg, entry.path), 'utf8'));
    value.data.title = '<script>alert(1)</script> [[SY-0001#p1]]';
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const dataset = verifyDatasetBytes({ ...entry, size: bytes.length, sha256: sha256Hex(bytes) }, bytes);
    const { html } = renderRecords(dataset, context);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="/original/SY-0001?page=1"');
  });
});
