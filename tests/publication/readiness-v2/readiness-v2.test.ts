import { describe, expect, it } from 'vitest';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import type { EvidenceReader } from '../../../src/lib/publication/hosted/ports.ts';
import { BASELINE, PREVIEWS, WARNINGS, buildEvidence, expectedGroups, fp, observations, snapshotV2, worldV2, type Built } from './harness.ts';

type Body = { evidence: { root: string; items: number; groups: unknown[]; newWarnings: number }; acknowledgementsRequired: number; blocker: unknown;
  page: { kind: string | null; size: number; items: { key: string; observation: Record<string, unknown>; acknowledgementRequired?: boolean }[]; next: string | null } };

/** Follows `page.next` to the end and returns every page, so a test can compare their union with the full set. */
async function walk(built: Built, pageSize: number, params: Record<string, string> = {}) {
  const w = worldV2(built, { pageSize }), pages: Body[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10_000; guard++) {
    const response = await createPublicationReadiness(w.ports).read(w.request(cursor ? { ...params, cursor } : params));
    expect(response.status).toBe(200);
    const body = await response.json() as Body;
    pages.push(body);
    cursor = body.page.next;
    if (!cursor) return { pages, w };
  }
  throw new Error('pagination did not end');
}

describe('readiness v2 over persisted evidence', () => {
  it('DECISIVE: 1,689 previews and 2,500 warnings return 200 with exact counts, and the pages are exactly the full set', async () => {
    const built = await buildEvidence({ failedPreviews: 9, pendingPreviews: 80 });
    const { pages } = await walk(built, 100);
    const all = observations({ failedPreviews: 9, pendingPreviews: 80 });
    // Exact counts, from the persisted rows and checked against the spec, not against the reader.
    const first = pages[0]!;
    expect(first.evidence.items).toBe(all.length);
    expect(first.evidence.groups).toEqual(expect.arrayContaining(expectedGroups(all)));
    expect(first.evidence.groups).toHaveLength(expectedGroups(all).length);
    const count = (kind: string) => (first.evidence.groups as { kind: string; count: number }[]).filter(g => g.kind === kind).reduce((n, g) => n + g.count, 0);
    expect(count('preview')).toBe(PREVIEWS);
    expect(count('warning')).toBe(WARNINGS);
    expect(first.evidence.newWarnings).toBe(WARNINGS - BASELINE);
    expect(first.acknowledgementsRequired).toBe(WARNINGS - BASELINE);
    expect(first.blocker).toEqual({ code: 'preview-not-ready', detail: ['failed:render-timeout=9', 'pending=80'] });
    // The pages together are exactly the full set: every key once, in order, none repeated, none dropped, none invented.
    const keys = pages.flatMap(p => p.page.items.map(i => i.key));
    expect(keys).toEqual(all.map(i => i.key));
    expect(pages.flatMap(p => p.page.items.map(i => i.observation))).toEqual(all.map(i => i.observation));
    expect(pages.length).toBe(Math.ceil(all.length / 100));
    expect(pages.every(p => p.page.items.length <= 100 && p.page.size === 100)).toBe(true);
    expect(pages.slice(0, -1).every(p => p.page.next !== null && p.page.items.length === 100)).toBe(true);
    expect(pages.at(-1)!.page.next).toBeNull();
    // Every page repeats the same sealed root.
    expect(new Set(pages.map(p => p.evidence.root))).toEqual(new Set([built.root]));
  }, 60_000);

  it.each([1, 7, 500])('page size %i, once injected, still returns exactly the full set', async size => {
    const built = await buildEvidence({ previews: 120, warnings: 260 });
    const { pages } = await walk(built, size);
    expect(pages.flatMap(p => p.page.items.map(i => i.key))).toEqual(observations({ previews: 120, warnings: 260 }).map(i => i.key));
    expect(pages.every(p => p.page.items.length <= size)).toBe(true);
  }, 60_000);

  it('a kind filter pages exactly that kind, and marks which warnings still need an acknowledgement', async () => {
    const built = await buildEvidence();
    const { pages } = await walk(built, 250, { kind: 'warning' });
    const items = pages.flatMap(p => p.page.items);
    expect(items.map(i => i.key)).toEqual(Array.from({ length: WARNINGS }, (_, n) => `warning/${fp(n)}`));
    expect(items.filter(i => i.acknowledgementRequired).length).toBe(WARNINGS - BASELINE);
    expect(items.slice(0, BASELINE).every(i => i.acknowledgementRequired === false)).toBe(true);
    expect(pages[0]!.page.kind).toBe('warning');
  }, 60_000);

  it('has no 200-entry or 256 KiB cap: a sign-off with 2,400 acknowledgements is observed, not refused', async () => {
    const built = await buildEvidence();
    const w = worldV2(built), snap = await snapshotV2(built);
    const { signoff } = await import('../../hosted-smoke/operator-workbench/fixtures.ts');
    const so = { ...signoff(), warningFingerprints: Array.from({ length: WARNINGS }, (_, n) => fp(n)),
      acknowledgements: Array.from({ length: WARNINGS - BASELINE }, (_, n) => ({ fingerprint: fp(BASELINE + n), reason: 'Synthetic reviewed warning' })) };
    expect(JSON.stringify(so).length).toBeGreaterThan(256 * 1024);
    w.current = snap;
    const ports = { ...w.ports, ledger: { ...w.ports.ledger!, signoff: async () => structuredClone(so) },
      evidenceFence: { protocol: 'coherent-evidence/1' as const, check: async () => 'current' as const } };
    const r = w.request({ signoffId: so.signoffId });
    const response = await createPublicationReadiness(ports).read(r);
    expect(response.status).toBe(200);
    expect((await response.json()).signoff).toMatchObject({ state: 'audited', invalidated: false });
  }, 60_000);

  it('records the same two audit events as v1 and reads the snapshot once per request', async () => {
    const built = await buildEvidence({ previews: 10, warnings: 10 });
    const w = worldV2(built);
    expect((await createPublicationReadiness(w.ports).read(w.request())).status).toBe(200);
    expect(w.w.events.map(e => e.action)).toEqual(['publication.readiness.intent', 'publication.readiness.release-intent']);
    expect(w.reads).toBe(1);
  });

  describe('fails closed', () => {
    const small = () => buildEvidence({ previews: 30, warnings: 30 });
    it('refuses a cursor from another root, a malformed cursor and a cursor used with another kind', async () => {
      const built = await small(), w = worldV2(built, { pageSize: 10 });
      const first = await (await createPublicationReadiness(w.ports).read(w.request())).json() as Body;
      const cursor = first.page.next!;
      const get = async (params: Record<string, string>) => createPublicationReadiness(w.ports).read(w.request(params));
      expect((await get({ cursor: 'not-a-cursor' })).status).toBe(422);
      expect((await get({ cursor, kind: 'warning' })).status).toBe(422);
      expect((await get({ kind: 'bogus' })).status).toBe(422);
      const other = await buildEvidence({ previews: 30, warnings: 31 });
      const foreign = await (await createPublicationReadiness(worldV2(other, { pageSize: 10 }).ports).read(worldV2(other, { pageSize: 10 }).request())).json() as Body;
      const response = await get({ cursor: foreign.page.next! });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('readiness-stale');
    });
    it('answers 503 for a v2 snapshot with no evidence reader, or with no evidence fence', async () => {
      const built = await small(), w = worldV2(built);
      expect((await createPublicationReadiness({ ...w.ports, evidence: null }).read(w.request())).status).toBe(503);
      expect((await createPublicationReadiness({ ...w.ports, evidenceFence: null }).read(w.request())).status).toBe(503);
      expect((await createPublicationReadiness({ ...w.ports, evidencePageSize: 0 }).read(w.request())).status).toBe(503);
      expect((await createPublicationReadiness({ ...w.ports, evidencePageSize: 501 }).read(w.request())).status).toBe(503);
    });
    it.each([
      ['a page that ends the evidence short of the snapshot item count', (rows: ReturnType<typeof rowsOf>) => rows.slice(0, -1)],
      ['a row whose observation is not the kind its key names', (rows: ReturnType<typeof rowsOf>) => rows.map((r, i) => i === 3 ? { ...r, key: r.key.replace('preview/', 'warning/') } : r)],
      ['a row with an unknown preview state', (rows: ReturnType<typeof rowsOf>) => rows.map((r, i) => i === 3 ? { ...r, json: r.json.replace('"rendered"', '"approved"') } : r)],
      ['a row bound to another results version', (rows: ReturnType<typeof rowsOf>) => rows.map((r, i) => i === 3 ? { ...r, json: r.json.replace(/"resultsVersion":"[^"]*"/, '"resultsVersion":"sha256:other"') } : r)],
      ['a row that is not JSON', (rows: ReturnType<typeof rowsOf>) => rows.map((r, i) => i === 3 ? { ...r, json: '{' } : r)],
    ])('answers 503 and releases nothing for %s', async (_name, mutate) => {
      const built = await buildEvidence({ previews: 20, warnings: 0, sections: [] }), w = worldV2(built, { pageSize: 500 });
      const real = built.reader;
      const evidence: EvidenceReader = { page: async a => { const rows = await real.page(a); return rows && mutate(rows as ReturnType<typeof rowsOf>); } };
      const response = await createPublicationReadiness({ ...w.ports, evidence }).read(w.request());
      expect(response.status).toBe(503);
      expect(w.w.events.map(e => e.action)).toEqual(['publication.readiness.intent']);
    });
    it('answers 409 when the persisted run no longer matches the snapshot root', async () => {
      const built = await small(), w = worldV2(built);
      const snap = await snapshotV2(built);
      w.current = { ...snap, evidence: { ...snap.evidence, root: 'f'.repeat(64) } };
      const response = await createPublicationReadiness(w.ports).read(w.request());
      expect(response.status).toBe(409);
    });
    it('answers 409 when the candidate changes after the pages were read', async () => {
      const built = await small(), w = worldV2(built), snap = await snapshotV2(built);
      const audit = w.ports.audit!;
      w.current = snap;
      const ports = { ...w.ports, audit: { async append(e: Parameters<typeof audit.append>[0]) {
        const out = await audit.append(e);
        if (e.action === 'publication.readiness.release-intent') w.current = { ...snap, snapshotRevision: 'd1:2' };
        return out;
      } } };
      expect((await createPublicationReadiness(ports).read(w.request())).status).toBe(409);
    });
  });
});
function rowsOf() { return [] as { key: string; json: string; baseline: boolean | null }[]; }
