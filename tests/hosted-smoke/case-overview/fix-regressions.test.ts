// Written-review probes promoted to regressions. Scripted ports and SSR only, not live hosted evidence.
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import NotesPage from '../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte';
import { load as caseLoad } from '../../../deploy/client/routes/cases/[caseId]/+page.server.ts';
import { load as chronoLoad } from '../../../deploy/client/routes/cases/[caseId]/views/[resultsVersion]/chronology/+page.server.ts';
import { actions, load as notesLoad } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { CASE, OLD_RV, RV, event, fake, form, outcome } from './doubles.ts';

const published = { kind: 'published' as const, resultsVersion: RV };
const OP = 'retry-document-note';
const post = (f: ReturnType<typeof fake>, fields: Record<string, string>) => {
  const r = form(fields);
  return outcome((actions.add as (e: never) => unknown)(event(f.services, { caseId: CASE }, r.url, r.init)));
};

it('M1: renders a refused document draft, retry identity and target even when the notes list fails', async () => {
  const f = fake({ publication: published, fail: { addNote: 'storage-unavailable', notesFor: 'storage-unavailable' } });
  const result = await post(f, { body: 'UNSAVED-DRAFT-CANARY', ref: 'DOC-002', resultsVersion: RV, operationId: OP });
  expect(result).toMatchObject({ value: { status: 503, data: { body: 'UNSAVED-DRAFT-CANARY', ref: 'DOC-002', resultsVersion: RV, operationId: OP } } });
  if (!('value' in result)) throw new Error('unexpected redirect');
  const data = await notesLoad(event(f.services, { caseId: CASE }));
  const body = render(NotesPage, { props: { data, form: (result.value as { data: never }).data } }).body;
  expect(body).toContain('data-notes-unavailable');
  expect(body).toContain('<textarea');
  expect(body).toContain('UNSAVED-DRAFT-CANARY');
  expect(body).toContain(`name="operationId" value="${OP}"`);
  expect(body).toContain('name="ref" value="DOC-002"');
  expect(body).toContain(`name="resultsVersion" value="${RV}"`);
});

it('M2: a coincident ref-shaped asset does not link an unmapped citation', async () => {
  const f = fake({ publication: published });
  f.services.assets.originals = async () => [{ assetId: 'DOC-001', filename: 'unrelated.pdf', mediaType: 'application/pdf', size: 999 }];
  // Explicitly no verified mapping; merely listing DOC-001 must never be enough.
  f.services.store = new Proxy(f.services.store, { get(t, p) { return p === 'originalAttributions' ? async () => [] : Reflect.get(t, p); } });
  const data = await chronoLoad(event(f.services, { caseId: CASE, resultsVersion: RV }));
  expect(data.chronology.items.find((r) => r.ref === 'DOC-001')!.originalHref).toBeNull();
});

it('M3: routine overview, chronology and notes reads never call bounded deep verification', async () => {
  const f = fake({ publication: published, verify: { ok: false, reason: 'busy', ms: 0 } });
  f.services.store = new Proxy(f.services.store, { get(t, p) { return p === 'publishedReadiness' ? async () => {} : Reflect.get(t, p); } });
  const data = await caseLoad(event(f.services, { caseId: CASE }));
  expect(data.overview).not.toBeNull();
  await chronoLoad(event(f.services, { caseId: CASE, resultsVersion: RV }));
  expect((await notesLoad(event(f.services, { caseId: CASE }))).resultsVersion).toBe(RV);
  expect(f.calls).not.toContain('verifyVersion');
});

it.each(['withdrawn', 'replaced'] as const)('M1: a refused annotation keeps its old target after results are %s and never saves as a case note', async (state) => {
  const publication = state === 'withdrawn' ? { kind: 'withdrawn' as const } : published;
  const f = fake({ publication, fail: { notesFor: 'storage-unavailable' } });
  const result = await post(f, { body: 'KEEP-OLD-DOCUMENT-TEXT', ref: 'DOC-002', resultsVersion: OLD_RV, operationId: OP });
  expect(result).toMatchObject({ value: { status: 409, data: { ref: 'DOC-002', resultsVersion: OLD_RV, operationId: OP } } });
  if (!('value' in result)) throw new Error('unexpected redirect');
  const data = await notesLoad(event(f.services, { caseId: CASE }));
  const body = render(NotesPage, { props: { data, form: (result.value as { data: never }).data } }).body;
  expect(body).toContain('data-note-target-moved');
  expect(body).toContain('KEEP-OLD-DOCUMENT-TEXT');
  // Replay the actual SSR form values (no browser or made-up target), including the old version.
  const field = (name: string) => { const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(body); if (!m) throw new Error(`missing ${name}`); return m[1]!; };
  const retry = await post(f, { body: 'KEEP-OLD-DOCUMENT-TEXT', ref: field('ref'), resultsVersion: field('resultsVersion'), operationId: field('operationId') });
  expect(retry).toMatchObject({ value: { status: 409 } });
  expect(f.calls).not.toContain('addNote');
  expect(f.writes).toEqual([]);
});

it.each(['busy', 'over-budget', 'storage-unavailable'] as const)('M3: cheap %s is unavailable, not a claim that published results are corrupt', async (code) => {
  const f = fake({ publication: published });
  f.services.store = new Proxy(f.services.store, { get(t, p) { return p === 'publishedReadiness' ? async () => { throw contractError(code); } : Reflect.get(t, p); } });
  const data = await caseLoad(event(f.services, { caseId: CASE }));
  expect(data.overview).toBeNull();
  expect(data.results).toEqual({ kind: 'unavailable', reason: 'The published results cannot be shown right now. Try again shortly.' });
  expect(f.calls).not.toContain('verifyVersion');
});

it('M3: an uncomposed reader fails closed without falling back to bounded deep verification', async () => {
  const f = fake({ publication: published });
  f.services.store = new Proxy(f.services.store, { get(t, p) { return p === 'publishedReadiness' ? undefined : Reflect.get(t, p); } });
  const data = await caseLoad(event(f.services, { caseId: CASE }));
  expect(data.overview).toBeNull();
  expect(data.results).toMatchObject({ kind: 'unavailable' });
  expect(f.calls).not.toContain('verifyVersion');
});
