import { describe, expect, it } from 'vitest';
import { canon } from './common.ts';
import { compareReadbacks, parseReadback, sealReadback, serializeReadback, type Readback } from './readback.ts';

const rv = `sha256:${'1'.repeat(64)}`;
const base = (over: Partial<Omit<Readback, 'digest' | 'schema'>> = {}) => sealReadback({
  deployedSha: 'a'.repeat(40), caseId: 'case-1', resultsVersion: rv, publication: { kind: 'published', resultsVersion: rv },
  originals: [{ assetId: 'sub-op-1', sha256: '2'.repeat(64), size: 461 }], chronology: [{ ref: 'JN-001', subject: 'Synthetic journey letter 0123456789ab', originalAssetId: 'sub-op-1' }],
  notes: [{ body: 'journey-note-0123456789ab case', annotation: null }, { body: 'journey-annotation-0123456789ab document', annotation: 'JN-001' }], exportSha256: '3'.repeat(64), ...over,
});
const text = (r: Readback) => serializeReadback(r);

describe('the exact readback parser', () => {
  it('round-trips a sealed readback byte for byte', () => {
    const r = base(), p = parseReadback(text(r));
    expect(p.ok).toBe(true);
    expect(p.ok && serializeReadback(p.readback)).toBe(text(r));
  });
  it('sorts lists into a fixed order, so the same facts give the same digest', () => {
    expect(base({ notes: [...base().notes].reverse() }).digest).toBe(base().digest);
  });
  it.each([
    ['an unknown key', (o: Record<string, unknown>) => ({ ...o, extra: 1 })],
    ['a missing key', (o: Record<string, unknown>) => { const { exportSha256: _e, ...rest } = o; return rest; }],
    ['a wrong schema', (o: Record<string, unknown>) => ({ ...o, schema: 'clearcase.native-journey-readback/2' })],
    ['a short sha', (o: Record<string, unknown>) => ({ ...o, deployedSha: 'abc' })],
    ['an unknown key inside a note', (o: Record<string, unknown>) => ({ ...o, notes: [{ body: 'x', annotation: null, hidden: true }] })],
    ['a withdrawn state that omits its version', (o: Record<string, unknown>) => ({ ...o, publication: { kind: 'withdrawn' } })],
  ])('refuses %s', (_n, edit) => {
    const doc = edit(JSON.parse(text(base())));
    expect(parseReadback(`${canon(doc)}\n`).ok).toBe(false);
  });
  it('refuses a tampered body whose digest no longer seals it', () => {
    const doc = JSON.parse(text(base())); doc.caseId = 'case-2';
    const p = parseReadback(`${canon(doc)}\n`);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.problems.join()).toContain('digest does not seal');
  });
  it('refuses non-canonical bytes: pretty printing, a missing or doubled final newline, reordered lists', () => {
    const r = base();
    expect(parseReadback(JSON.stringify(r, null, 1)).ok).toBe(false);
    expect(parseReadback(text(r).trimEnd()).ok).toBe(false);
    expect(parseReadback(`${text(r)}\n`).ok).toBe(false);
    const reordered = JSON.parse(text(r)); reordered.notes.reverse();
    const p = parseReadback(`${canon(reordered)}\n`);
    expect(p.ok).toBe(false);
  });
  it.each([
    ['a JWT', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJl'],
    ['a Clerk secret key', 'sk_test_abcdefghijklmnop1234'],
    ['a session id', 'sess_2abcdefghijklmnopq'],
    ['an e-mail address', 'someone@example.com'],
    ['a cookie assignment', '__session=abcdef'],
  ])('refuses a readback carrying %s anywhere', (_n, secret) => {
    const r = base({ notes: [{ body: `leak ${secret}`, annotation: null }] });
    const p = parseReadback(text(r));
    expect(p.ok).toBe(false);
    expect(!p.ok && p.problems.join()).toContain('secret-like');
  });
  it('refuses a document that is not JSON', () => { expect(parseReadback('not json').ok).toBe(false); });
});

describe('comparing readbacks across a restart', () => {
  it('equal facts compare equal even when the export bytes differ', () => {
    expect(compareReadbacks(base(), base({ exportSha256: '4'.repeat(64) }), { exportMustMatch: false })).toEqual([]);
  });
  it.each([
    ['a lost note', { notes: [{ body: 'journey-note-0123456789ab case', annotation: null }] }, 'notes'],
    ['an unpublished version', { publication: { kind: 'none' } as const }, 'publication'],
    ['an altered original', { originals: [{ assetId: 'sub-op-1', sha256: '9'.repeat(64), size: 461 }] }, 'originals'],
    ['a lost citation link', { chronology: [{ ref: 'JN-001', subject: 'Synthetic journey letter 0123456789ab', originalAssetId: null }] }, 'chronology'],
    ['another commit', { deployedSha: 'b'.repeat(40) }, 'deployedSha'],
  ])('reports %s', (_n, after, field) => {
    expect(compareReadbacks(base(), base(after), { exportMustMatch: false })).toContain(field);
  });
  it('can require the export to match', () => {
    expect(compareReadbacks(base(), base({ exportSha256: '4'.repeat(64) }), { exportMustMatch: true })).toEqual(['exportSha256']);
  });
});
