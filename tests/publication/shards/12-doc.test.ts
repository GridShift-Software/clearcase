// Sprint ticket 12: the document shard family. `doc/<ref>.json` exists for every document of the synthetic version and
// matches DocShard; the original states are `available`, `missing` and `embedded`; `documents/default.json` is the model
// the unfiltered documents list has locally.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { originalStateOf } from '../../../scripts/publish/shards/doc.ts';
import type { DocumentStateRow } from '../../../src/lib/local-case/model.ts';
import { documentsModel } from '../../../src/lib/views/evidence/documents.ts';
import type { DocShard } from '../../../src/lib/views/payloads/doc.ts';
import type { DocumentsDefaultShard } from '../../../src/lib/views/payloads/documents.ts';
import type { ListPage } from '../../../src/lib/views/payloads/list.ts';
import { type BuiltCase } from './world.ts';
import { BULK, docCase, KID_GONE, KID_OK, NO_FILE, PARENT } from './12-world.ts';

let b: BuiltCase;
beforeAll(async () => { b = await docCase(); }, 120_000);
afterAll(() => b?.cleanup());
const parse = <T>(name: string) => JSON.parse(new TextDecoder().decode(b.files.get(name)!)) as T;
const doc = (ref: string) => parse<DocShard>(`doc/${ref}.json`);
const listRows = () => Array.from({ length: b.built.manifest.counts.listPages }, (_, i) => parse<ListPage>(`list/page-${i + 1}.json`)).flatMap((p) => p.rows);

describe('12 document shards', () => {
  test('one doc/<ref>.json per document, and the manifest names each', () => {
    const refs = listRows().map((r) => r.ref).sort();
    expect(refs.length).toBe(b.built.manifest.counts.documents);
    expect(refs.length).toBeGreaterThan(BULK);
    expect([...b.files.keys()].filter((n) => n.startsWith('doc/')).sort()).toEqual(refs.map((r) => `doc/${r}.json`).sort());
    const named = new Set(b.built.manifest.shards.map((s) => s.name));
    for (const r of refs) expect(named.has(`doc/${r}.json`)).toBe(true);
    for (const r of refs) expect(doc(r).ref).toBe(r);
  });

  test('a stored original is available, with its own asset id and media type', () => {
    const d = doc(KID_OK);
    expect([d.originalState, d.assetIds.own, d.mediaType, d.source]).toEqual(['available', KID_OK, 'application/pdf', 'results']);
    expect(d.state.original).toMatchObject({ mediaType: 'application/pdf', downloadOnly: false });
    expect(d.fields).toMatchObject({ subject: `Synthetic ${KID_OK}`, bundle: 'Kids', docType: 'other' });
  });

  test('a file that was not supplied is missing: no asset to link', () => {
    for (const ref of [KID_GONE, NO_FILE]) {
      const d = doc(ref);
      expect([d.originalState, d.assetIds.own]).toEqual(['missing', null]);
    }
  });

  test('an e-mail attachment is embedded: no bytes of its own, reached through the parent', () => {
    const mail = doc(PARENT);
    const inside = mail.attachments.filter((x) => x.kind === 'embedded');
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((x) => x.route === 'parent' && x.via === PARENT && x.hasDocument === false)).toBe(true);
    expect(mail.attachments.filter((x) => x.route === 'direct').map((x) => [x.key, x.hasDocument])).toEqual([[KID_OK, true]]);
    expect(mail.assetIds.attachments).toEqual([KID_OK]);
    expect(mail.children).toEqual([KID_OK, KID_GONE]);
    const embedded: DocumentStateRow = { file: 'missing', preview: 'none', text: 'pending', mediaType: 'image/png', flags: [], original: null, self: { route: 'parent', parentRef: PARENT, reason: null, via: PARENT } };
    expect(originalStateOf(embedded)).toBe('embedded');
    expect(originalStateOf({ ...embedded, self: null, flags: ['embedded'] })).toBe('embedded');
    expect(originalStateOf({ ...embedded, self: null })).toBe('missing');
  });

  test('parent, related documents and children carry whether they have a page', () => {
    const d = doc(KID_OK);
    expect(d.parent).toEqual({ ref: PARENT, exists: true });
    expect(d.related).toEqual([{ ref: PARENT, exists: true }, { ref: 'BK-0001', exists: true }, { ref: 'ZZ-9999', exists: false }]);
    expect(doc('BK-0001').parent).toBeNull();
  });

  test('documents/default.json is the unfiltered documents model with the case total', () => {
    const d = parse<DocumentsDefaultShard>('documents/default.json');
    const rows = listRows();
    expect(d.total).toBe(rows.length);
    expect(d.model).toEqual(documentsModel(rows, { bundle: null, q: '', page: null }));
    expect(d.model.page.slice.length).toBe(Math.min(60, d.model.bundles[0]!.count));
    expect(d.model.bundles.reduce((s, x) => s + x.count, 0)).toBe(rows.length);
  });
});
