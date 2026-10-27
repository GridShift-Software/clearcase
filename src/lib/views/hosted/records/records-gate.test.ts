// The `records-rendered` check must check what it claims to. Each test is a reviewer probe from
// .orchestration/reports/alpha-hardening-20261027/rx-records-view-review.md (Mediums 1 to 5).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateCorpus } from '../../../../../scripts/fixtures/synthetic/corpus.ts';
import { canonicalJson } from '../../../case-package/canonical.ts';
import { sha256Hex } from '../../../case-package/hash.ts';
import type { ManifestFile } from '../../../case-package/schema.ts';
import { renderRecords, recordsSectionState, verifyDatasetBytes, type VerifiedDataset } from './index.ts';

// Simulates a renderer regression: a string containing the sentinel renders as nothing.
vi.mock('../../../case-package/render.ts', async (original) => {
  const real = await original<typeof import('../../../case-package/render.ts')>();
  return { ...real, displayText: (s: string) => (s.includes('DROPPED-BY-RENDERER') ? '' : real.displayText(s)) };
});

let root: string;
let pkg: string;
let files: ManifestFile[];
const context = { originalHref: (ref: string, page: number | null) => `/original/${ref}${page ? `?page=${page}` : ''}` };

const entryOf = (key: string) => files.find(f => f.key === key && f.role === 'dataset')!;
async function envelopeOf(key: string): Promise<{ entry: ManifestFile; value: any }> {
  const entry = entryOf(key);
  return { entry, value: JSON.parse(await readFile(path.join(pkg, entry.path), 'utf8')) };
}
function verified(entry: ManifestFile, value: any): VerifiedDataset {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return verifyDatasetBytes({ ...entry, size: bytes.length, sha256: sha256Hex(bytes), count: value.count }, bytes);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'records-gate-'));
  pkg = path.join(root, 'corpus', 'pkg');
  await generateCorpus({ out: path.join(root, 'corpus'), seed: 'records-gate', documents: 24, profile: 'poc' });
  files = JSON.parse(await readFile(path.join(pkg, 'manifest.json'), 'utf8')).files;
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('Medium 1: the check proves data values are present', () => {
  it('rejects a render that leaves a value out, even when the same renderer produced the expected form', async () => {
    const { entry, value } = await envelopeOf('chronology');
    value.data[0].subject = 'DROPPED-BY-RENDERER subject';
    const dataset = verified(entry, value);
    const rendered = renderRecords(dataset, context);
    expect(rendered.html).not.toContain('DROPPED-BY-RENDERER');
    expect(recordsSectionState(dataset, rendered, context)).toBe('invalid');
  });
  it('rejects a render whose value cell is emptied', async () => {
    const { entry, value } = await envelopeOf('chronology');
    value.data[0].subject = 'distinctive subject text';
    const dataset = verified(entry, value);
    const rendered = renderRecords(dataset, context);
    expect(recordsSectionState(dataset, rendered, context)).toBe('records-rendered');
    expect(recordsSectionState(dataset, { ...rendered, html: rendered.html.replace('distinctive subject text', '') }, context)).toBe('invalid');
  });
});

/** Expected record markers, derived from the validator's rule (validate.ts elementIds), not from the renderer. */
function expectedRecordMarkers(data: unknown, topLevelRefField: boolean): string[] {
  const out: string[] = [];
  const short = (s: string) => sha256Hex(s).slice(0, 12);
  const text = (v: unknown) => (typeof v === 'string' ? v : canonicalJson(v));
  const escape = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
  function walk(value: unknown, at: string): void {
    if (Array.isArray(value)) {
      const seen = new Map<string, number>();
      value.forEach((el, i) => {
        let id: string;
        if (at === '/data' && topLevelRefField && el && typeof el === 'object' && typeof (el as any).ref === 'string' && (el as any).ref !== '') id = `ref:${(el as any).ref}`;
        else {
          const d = short(text(el));
          const n = (seen.get(d) ?? 0) + 1; seen.set(d, n);
          id = n === 1 ? `#${d}` : `#${d}~${n}`;
        }
        out.push(sha256Hex(`${at}/${id}`));
        walk(el, `${at}/${id}`);
      });
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${at}/${escape(k)}`);
    }
  }
  walk(data, '/data');
  return out;
}

describe('Medium 2: record identities match the validator derivation', () => {
  it('pins the validator value for a string element (50d858e0985e for "example")', async () => {
    const { entry, value } = await envelopeOf('chronology');
    value.data[0].ref = 'SY-0001';
    value.data[0].also_in = ['example'];
    const dataset = verified(entry, value);
    const { markers } = renderRecords(dataset, context);
    expect(sha256Hex('example').slice(0, 12)).toBe('50d858e0985e');
    expect(markers.records).toContain(sha256Hex('/data/ref:SY-0001/also_in/#50d858e0985e'));
  });
  it('matches independently derived identities for every dataset, nested arrays and string elements included', async () => {
    const keys = files.filter(f => f.role === 'dataset' && f.schema?.startsWith('v5.')).map(f => f.key!);
    let nested = 0;
    for (const key of keys) {
      const { entry, value } = await envelopeOf(key);
      const dataset = verified(entry, value);
      const { markers } = renderRecords(dataset, context);
      const expected = expectedRecordMarkers(value.data, key === 'chronology');
      expect([...markers.records].sort(), key).toEqual([...expected].sort());
      if (expected.length > (Array.isArray(value.data) ? value.data.length : 0)) nested++;
    }
    expect(nested).toBeGreaterThan(0);
  }, 120_000);
});

describe('Medium 3: a wrong or relabelled citation fails the check', () => {
  async function citing() {
    const { entry, value } = await envelopeOf('matter');
    value.data.title = 'See [[SY-0001#p1]] for the order.';
    const dataset = verified(entry, value);
    return { dataset, rendered: renderRecords(dataset, context) };
  }
  it('accepts the exact render for the same route', async () => {
    const { dataset, rendered } = await citing();
    expect(rendered.html).toContain('href="/original/SY-0001?page=1"');
    expect(recordsSectionState(dataset, rendered, context)).toBe('records-rendered');
  });
  it('compares record identities without sorting, so the check stays linear', async () => {
    const { dataset, rendered } = await citing();
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      expect(recordsSectionState(dataset, rendered, context)).toBe('records-rendered');
      expect(sort).not.toHaveBeenCalled();
    } finally { sort.mockRestore(); }
  });
  it('rejects a link to another original', async () => {
    const { dataset, rendered } = await citing();
    const html = rendered.html.replace('href="/original/SY-0001?page=1"', 'href="/original/SY-9999"');
    expect(html).not.toBe(rendered.html);
    expect(recordsSectionState(dataset, { ...rendered, html }, context)).toBe('invalid');
  });
  it('rejects a relabelled citation', async () => {
    const { dataset, rendered } = await citing();
    const html = rendered.html.replace('>SY-0001 p.1<', '>SY-0002 p.7<');
    expect(html).not.toBe(rendered.html);
    expect(recordsSectionState(dataset, { ...rendered, html }, context)).toBe('invalid');
  });
  it('rejects a citation turned into a broken span, and a render made under a different route', async () => {
    const { dataset, rendered } = await citing();
    const broken = rendered.html.replace(/<a class="cite" href="[^"]*">[^<]*<\/a>/, '<span class="cite-broken" title="Citation does not resolve">[[SY-0001#p1]]</span>');
    expect(broken).not.toBe(rendered.html);
    expect(recordsSectionState(dataset, { ...rendered, html: broken }, context)).toBe('invalid');
    const elsewhere = renderRecords(dataset, { originalHref: (ref, page) => `/other/${ref}${page ? `?page=${page}` : ''}` });
    expect(recordsSectionState(dataset, elsewhere, context)).toBe('invalid');
  });
});

describe('Medium 4: only verifyDatasetBytes output can return records-rendered', () => {
  it('refuses a hand-built object and a copy of a verified dataset', async () => {
    const { entry, value } = await envelopeOf('people');
    const real = verified(entry, value);
    const rendered = renderRecords(real, context);
    expect(recordsSectionState(real, rendered, context)).toBe('records-rendered');
    const forged = { key: real.key, schemaId: real.schemaId, packagePath: real.packagePath, sha256: 'not-a-hash', size: -1, value: real.value } as unknown as VerifiedDataset;
    expect(recordsSectionState(forged, rendered, context)).toBe('invalid');
    expect(() => renderRecords(forged, context)).toThrow();
    const copy = { ...real } as VerifiedDataset;
    expect(recordsSectionState(copy, rendered, context)).toBe('invalid');
    expect(() => renderRecords(copy, context)).toThrow();
  });
});

describe('Medium 5: the state check runs in linear time', () => {
  it('checks 13,512 records within the bound', async () => {
    const { entry, value } = await envelopeOf('chronology');
    const template = value.data[0];
    const total = 13_512;
    value.data = Array.from({ length: total }, (_, i) => ({ ...template, ref: `SY-${String(i + 1).padStart(6, '0')}`, subject: `Scale subject ${i}`, also_in: [`other-${i % 50}`] }));
    value.count = total;
    const dataset = verified(entry, value);
    const t0 = performance.now();
    const rendered = renderRecords(dataset, context);
    const t1 = performance.now();
    const state = recordsSectionState(dataset, rendered, context);
    const t2 = performance.now();
    console.log(`records scale: ${total} top-level records, ${rendered.markers.records.length} markers, render ${Math.round(t1 - t0)} ms, state check ${Math.round(t2 - t1)} ms`);
    expect(state).toBe('records-rendered');
    expect(t2 - t1).toBeLessThan(20_000);
  }, 180_000);
});
