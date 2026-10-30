// The case page (deploy/client/routes/cases/[caseId]/+page.server.ts) driven through its real load function with the
// scripted RequestServices of doubles.ts. Unit doubles only: no D1, R2, workerd, identity provider or browser.
import { describe, expect, it } from 'vitest';
import { load } from '../../../deploy/client/routes/cases/[caseId]/+page.server.ts';
import { CASE, OLD_RV, RV, event, fake, outcome } from './doubles.ts';

const published = { kind: 'published' as const, resultsVersion: RV };
type Data = Awaited<ReturnType<typeof load>>;
const run = async (f: ReturnType<typeof fake>, caseId: string = CASE) => outcome(load(event(f.services, { caseId })) as Promise<Data>);

describe('hosted case page: published overview', () => {
  it('shows the current published version\'s overview from derived counts and view content, with a version-scoped chronology link', async () => {
    const f = fake({ publication: published });
    const r = await run(f);
    if (!('value' in r)) throw new Error(`load refused ${JSON.stringify(r.thrown)}`);
    const d = r.value as Data & { overview: { resultsVersion: string; documents: { total: number }; subtitle: string | null; chronologyHref: string; tallies: { byBundle: [string, number][] } } | null };
    expect(d.results).toBeNull();
    expect(d.overview).not.toBeNull();
    expect(d.overview!.resultsVersion).toBe(RV);
    expect(d.overview!.documents.total).toBe(3);
    expect(d.overview!.subtitle).toBe('3 documents in a synthetic matter');
    expect(d.overview!.chronologyHref).toBe(`/cases/${CASE}/v/${encodeURIComponent(RV)}/chronology`);
    // dataset names never become object keys in page data
    expect(d.overview!.tallies.byBundle).toContainEqual(['__proto__', 1]);
    expect(f.calls[0]).toBe('getCase');
  });

  it('shows results unavailable, and no content, when the store\'s active version is not the published one', async () => {
    const f = fake({ publication: published, active: OLD_RV });
    const r = await run(f);
    if (!('value' in r)) throw new Error('refused');
    expect(r.value.results).toMatchObject({ kind: 'unavailable' });
    expect((r.value as { overview?: unknown }).overview ?? null).toBeNull();
    expect(f.calls).not.toContain('listJson');
    expect(f.calls).not.toContain('viewContentOf');
  });

  it('shows results unavailable when the published version fails its integrity check', async () => {
    const f = fake({ publication: published, verify: { ok: false, reason: 'digest', ms: 1 } });
    const r = await run(f);
    if (!('value' in r)) throw new Error('refused');
    expect(r.value.results).toMatchObject({ kind: 'unavailable' });
    expect((r.value as { overview?: unknown }).overview ?? null).toBeNull();
    expect(f.calls).not.toContain('getVersion');
  });
});

describe('hosted case page: identity case read and independent parts', () => {
  it('reads the case through the authorized case read before any other metadata, and a denial releases nothing', async () => {
    const f = fake({ publication: published, fail: { getCase: 'forbidden' } });
    const r = await run(f);
    expect('thrown' in r && r.thrown.status).toBe(404);
    expect(f.calls).toEqual(['getCase']);
  });

  it('a pending case shows the waiting state, its originals and notes, and asks the store for no version', async () => {
    const f = fake({ publication: { kind: 'none' } });
    const r = await run(f);
    if (!('value' in r)) throw new Error('refused');
    expect(r.value.results).toEqual({ kind: 'pending' });
    expect(r.value.originals.state).toBe('available');
    expect(r.value.notes.state).toBe('available');
    expect(f.calls.filter((c) => !['getCase', 'originals', 'notesFor'].includes(c))).toEqual([]);
  });

  it('a withdrawn case shows withdrawn, and a results-storage fault does not hide originals or notes', async () => {
    const w = fake({ publication: { kind: 'withdrawn' } });
    const rw = await run(w);
    if (!('value' in rw)) throw new Error('refused');
    expect(rw.value.results).toEqual({ kind: 'withdrawn' });
    const s = fake({ publication: published, fail: { store: 'storage-unavailable' } });
    const rs = await run(s);
    if (!('value' in rs)) throw new Error('refused');
    expect(rs.value.results).toMatchObject({ kind: 'unavailable' });
    expect(rs.value.originals.state).toBe('available');
    expect(rs.value.notes.state).toBe('available');
  });

  it('a denial from a later part fails the whole page instead of showing it as unavailable', async () => {
    const f = fake({ publication: published, fail: { originals: 'forbidden' } });
    const r = await run(f);
    expect('thrown' in r && r.thrown.status).toBe(404);
  });

  it('an unknown or malformed case id is 404 without a store read beyond the case read', async () => {
    const f = fake({ publication: published, missingCase: true });
    expect(await run(f)).toMatchObject({ thrown: { status: 404 } });
    expect(f.calls).toEqual(['getCase']);
    const g = fake({ publication: published });
    expect(await run(g, '../etc')).toMatchObject({ thrown: { status: 404 } });
    expect(g.calls).toEqual([]);
  });
});
