// Sprint ticket 06: `build` on a synthetic package writes every shard family, each parses as its payloads type, and the
// manifest names every shard with its exact bytes and sha256.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { canonicalJson } from '../../../src/lib/case-package/canonical.ts';
import { LIST_PAGE_ROWS, type FacetsShard, type ListPage } from '../../../src/lib/views/payloads/list.ts';
import { SHARD_MANIFEST_FORMAT, type PayloadManifest } from '../../../src/lib/views/payloads/manifest.ts';
import type { OverviewShard } from '../../../src/lib/views/payloads/overview.ts';
import type { ShellShard } from '../../../src/lib/views/payloads/shell.ts';
import type { OriginalEntry } from '../../../scripts/publish/shards/originals.ts';
import { builtCase, CASE_ID, EXTRA_ROWS, type BuiltCase } from './world.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const parse = <T>(b: BuiltCase, name: string) => JSON.parse(new TextDecoder().decode(b.files.get(name)!)) as T;
let b: BuiltCase;
beforeAll(async () => { b = await builtCase(); }, 120_000);
afterAll(() => b?.cleanup());

describe('06 shard builder', () => {
  test('writes the shell, overview, list pages and facets, originals and the manifest', () => {
    const pages = [...b.files.keys()].filter((n) => n.startsWith('list/page-')).length;
    expect(pages).toBeGreaterThan(1);
    // The tracer's own families; a later ticket's shard family (its own test) is named here by its prefix.
    const later = ['doc/', 'documents/'];
    expect([...b.files.keys()].filter((n) => !later.some((p) => n.startsWith(p))).sort()).toEqual(['list/facets.json', ...Array.from({ length: pages }, (_, i) => `list/page-${i + 1}.json`), 'manifest.json', 'originals.json', 'overview.json', 'shell.json'].sort());
  });

  test('the manifest is canonical, sorted by name, and names every other shard with its bytes and sha256', () => {
    const bytes = b.files.get('manifest.json')!;
    const m = parse<PayloadManifest>(b, 'manifest.json');
    expect(new TextDecoder().decode(bytes)).toBe(canonicalJson(m));
    expect(sha(bytes)).toBe(b.built.manifestSha256);
    expect(b.built.record.shardManifestSha256).toBe(b.built.manifestSha256);
    expect(m.format).toBe(SHARD_MANIFEST_FORMAT);
    expect([m.caseId, m.resultsVersion, m.readModelSha256]).toEqual([CASE_ID, b.synth.resultsVersion, b.built.record.version.readModelSha256]);
    expect(m.shards.map((s) => s.name)).toEqual([...b.files.keys()].filter((n) => n !== 'manifest.json').sort());
    for (const s of m.shards) expect([s.name, s.bytes, s.sha256]).toEqual([s.name, b.files.get(s.name)!.byteLength, sha(b.files.get(s.name)!)]);
    expect(m.counts.listPages).toBe(m.shards.filter((s) => s.name.startsWith('list/page-')).length);
  });

  test('each shard parses as its payloads type', () => {
    const m = parse<PayloadManifest>(b, 'manifest.json');
    const shell = parse<ShellShard>(b, 'shell.json');
    expect([shell.version.id, shell.version.caseId, shell.documents]).toEqual([b.synth.resultsVersion, CASE_ID, m.counts.documents]);
    expect(typeof shell.version.titleName).toBe('string');

    const overview = parse<OverviewShard>(b, 'overview.json');
    expect([overview.overview.counts.documents, overview.documents.total]).toEqual([m.counts.documents, m.counts.documents]);
    expect(Array.isArray(overview.tallies.byBundle)).toBe(true);

    const pages = Array.from({ length: m.counts.listPages }, (_, i) => parse<ListPage>(b, `list/page-${i + 1}.json`));
    const total = m.counts.documents;
    expect(total).toBeGreaterThan(EXTRA_ROWS);
    for (const [i, p] of pages.entries()) {
      expect([p.page, p.pages, p.total]).toEqual([i + 1, pages.length, total]);
      expect(p.rows.length).toBe(i < pages.length - 1 ? LIST_PAGE_ROWS : total - LIST_PAGE_ROWS * (pages.length - 1));
    }
    const rows = pages.flatMap((p) => p.rows);
    expect(new Set(rows.map((r) => r.ref)).size).toBe(total);
    expect(rows.map((r) => r.ord)).toEqual([...rows.map((r) => r.ord)].sort((x, y) => x - y));

    const facets = parse<FacetsShard>(b, 'list/facets.json');
    for (const f of [facets.bundles, facets.docTypes, facets.textStatuses]) expect(f.reduce((s, [, n]) => s + n, 0)).toBe(total);
    expect(facets.bundles.map(([v]) => v)).toEqual(expect.arrayContaining(['Bulk A', 'Bulk B']));
    expect(facets.years.map(([y]) => y)).toEqual(expect.arrayContaining(['2000', '2004']));

    const originals = parse<OriginalEntry[]>(b, 'originals.json');
    expect(originals.length).toBe(m.counts.assets);
    const bulk = originals.find((o) => o.filename === 'BK-0000 Synthetic.pdf')!;
    expect([bulk.mediaType, bulk.downloadOnly, bulk.size, bulk.sha256?.length]).toEqual(['application/pdf', false, expect.any(Number), 64]);
  });

  test('the register record carries the rows D1 needs, one per document, asset and seed', () => {
    const r = b.built.record;
    expect([r.rows.documents.length, r.rows.assets.length, r.rows.seeds.length]).toEqual([r.version.expect.documents, r.version.expect.assets, r.version.expect.seeds]);
    expect(r.rows.documents.every((d) => JSON.parse(d.list_json).ref === d.ref)).toBe(true);
  });
});
