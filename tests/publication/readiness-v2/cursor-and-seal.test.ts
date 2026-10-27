import { describe, expect, it } from 'vitest';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import { CASE, CLIENT } from '../../hosted-smoke/operator-workbench/fixtures.ts';
import { buildEvidence, fp, snapshotV2, worldV2, type Built } from './harness.ts';

type Body = { code?: string; acknowledgementsRequired: number; page: { items: { key: string; acknowledgementRequired?: boolean }[]; next: string | null } };
const run = (built: Built) => ({ clientId: CLIENT, caseId: CASE, candidateId: built.binding.candidateId, generation: built.binding.generation });
const insertLate = (built: Built, key: string, json: string) =>
  built.db.prepare('INSERT INTO pub_evidence_item (candidate_id, generation, item_key, item_json) VALUES (?, ?, ?, ?)').run(built.binding.candidateId, built.binding.generation, key, json);
const lateWarning = (built: Built, n: number) => {
  const original = built.db.prepare("SELECT item_json FROM pub_evidence_item WHERE item_key LIKE 'warning/%' LIMIT 1").get() as { item_json: string };
  const late = JSON.parse(original.item_json);
  late.observation = { kind: 'warning', fingerprint: fp(n) };
  return JSON.stringify(late);
};

// A cursor continues one series of pages. It names the generation, the evidence root and the baseline (snapshot revision) it was issued
// for; any change refuses the continuation with the restart signal (409 readiness-stale) rather than serving pages from two states.
describe('a page cursor is bound to the generation, the root and the baseline it was issued for', () => {
  it('refuses a cursor from generation 1 against a generation 2 rebuilt with an identical root', async () => {
    const a = await buildEvidence({ previews: 10, warnings: 4 }, { generation: '1' });
    const b = await buildEvidence({ previews: 10, warnings: 4 }, { generation: '2' });
    expect(a.root).toBe(b.root);
    const first = await createPublicationReadiness(worldV2(a, { pageSize: 3 }).ports).read(worldV2(a, { pageSize: 3 }).request());
    expect(first.status).toBe(200);
    const cursor = ((await first.json()) as Body).page.next!;
    const replacement = worldV2(b, { pageSize: 3 });
    replacement.current = { ...await snapshotV2(b), snapshotRevision: 'd1:2' };
    const second = await createPublicationReadiness(replacement.ports).read(replacement.request({ cursor }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as Body).code).toBe('readiness-stale');
  });
  it('refuses a cursor from generation 1 even when the replacement carries the same snapshot revision', async () => {
    const a = await buildEvidence({ previews: 10, warnings: 4 }, { generation: '1' });
    const b = await buildEvidence({ previews: 10, warnings: 4 }, { generation: '2' });
    const first = worldV2(a, { pageSize: 3 });
    const cursor = ((await (await createPublicationReadiness(first.ports).read(first.request())).json()) as Body).page.next!;
    const replacement = worldV2(b, { pageSize: 3 });
    expect((await createPublicationReadiness(replacement.ports).read(replacement.request({ cursor }))).status).toBe(409);
  });
  it('refuses a cursor after the warning baseline changes, though the evidence root is the same', async () => {
    const built = await buildEvidence({ previews: 0, warnings: 6, sections: [] });
    const w = worldV2(built, { pageSize: 3 });
    const first = await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning' }));
    expect(first.status).toBe(200);
    const body = (await first.json()) as Body;
    expect(body.page.items.every(x => x.acknowledgementRequired === false)).toBe(true);
    built.db.prepare('DELETE FROM rs_trusted_fingerprint WHERE case_id = ?').run(CASE);
    w.current = { ...await snapshotV2(built), snapshotRevision: 'd1:2' };
    const second = await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning', cursor: body.page.next! }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as Body).code).toBe('readiness-stale');
  });
  it('restarts cleanly: the first page of the new state is served and its cursor continues', async () => {
    const built = await buildEvidence({ previews: 0, warnings: 6, sections: [] });
    const w = worldV2(built, { pageSize: 3 });
    const old = ((await (await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning' }))).json()) as Body).page.next!;
    built.db.prepare('DELETE FROM rs_trusted_fingerprint WHERE case_id = ?').run(CASE);
    w.current = { ...await snapshotV2(built), snapshotRevision: 'd1:2' };
    const restarted = await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning' }));
    expect(restarted.status).toBe(200);
    const body = (await restarted.json()) as Body;
    expect(body.acknowledgementsRequired).toBe(6);
    expect(body.page.items.every(x => x.acknowledgementRequired === true)).toBe(true);
    expect(body.page.next).not.toBe(old);
    const next = await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning', cursor: body.page.next! }));
    expect(next.status).toBe(200);
    expect(((await next.json()) as Body).page.items.map(x => x.key)).toEqual([3, 4, 5].map(n => `warning/${fp(n)}`));
  });
  it('refuses a cursor whose binding was edited, or that has the old shape without one', async () => {
    const built = await buildEvidence({ previews: 0, warnings: 6, sections: [] });
    const w = worldV2(built, { pageSize: 3 });
    const cursor = ((await (await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning' }))).json()) as Body).page.next!;
    const parsed = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>;
    const encode = (v: unknown) => btoa(JSON.stringify(v)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const { r, k, a } = parsed;
    const edited = encode({ ...parsed, b: '0'.repeat(64) });
    const legacy = encode({ v: 1, r, k, a });
    for (const bad of [edited, legacy]) {
      const status = (await createPublicationReadiness(w.ports).read(w.request({ kind: 'warning', cursor: bad }))).status;
      expect([409, 422]).toContain(status);
    }
  });
});

// Readiness serves only the rows the sealed root covers. A row inserted after sealing, below or above the greatest key, is refused.
describe('a page serves only the rows the sealed root covers', () => {
  it('refuses a page when a row was appended above the greatest sealed key', async () => {
    const built = await buildEvidence({ previews: 0, warnings: 6, sections: [] });
    insertLate(built, `warning/${fp(999)}`, lateWarning(built, 999));
    const page = await built.reader.page({ ...run(built), root: built.root, after: `warning/${fp(2)}`, kind: null, limit: 100 });
    expect(page).toBeNull();
  });
  it('refuses a page when a row was inserted below the greatest sealed key', async () => {
    const built = await buildEvidence({ previews: 0, warnings: 6, sections: [] });
    insertLate(built, `warning/${fp(3)}0`, lateWarning(built, 31));
    expect(await built.reader.page({ ...run(built), root: built.root, after: null, kind: null, limit: 100 })).toBeNull();
    expect(await built.reader.page({ ...run(built), root: built.root, after: null, kind: 'warning', limit: 100 })).toBeNull();
  });
  it('refuses the empty tail page too, so a late row cannot make an uncovered run look complete', async () => {
    const built = await buildEvidence({ previews: 0, warnings: 6, sections: [] });
    insertLate(built, `zzz/late`, '{}');
    expect(await built.reader.page({ ...run(built), root: built.root, after: `warning/${fp(5)}`, kind: null, limit: 100 })).toBeNull();
  });
  it('answers 409 to a request series that was interrupted by a row inserted after the first page', async () => {
    const built = await buildEvidence({ previews: 0, warnings: 6, sections: [] });
    const w = worldV2(built, { pageSize: 3 });
    const first = await createPublicationReadiness(w.ports).read(w.request());
    expect(first.status).toBe(200);
    const cursor = ((await first.json()) as Body).page.next!;
    insertLate(built, `warning/${fp(999)}`, lateWarning(built, 999));
    const second = await createPublicationReadiness(w.ports).read(w.request({ cursor }));
    expect([409, 503]).toContain(second.status);
    expect(second.status).not.toBe(200);
  });
  it('still serves a sealed run whose rows are untouched', async () => {
    const built = await buildEvidence({ previews: 8, warnings: 6 });
    const page = await built.reader.page({ ...run(built), root: built.root, after: null, kind: null, limit: 100 });
    expect(page?.length).toBe(17);
  });
});
