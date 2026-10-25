// Compiles and mounts the real route and viewer. Only the reader and HTTP transport are doubles;
// these are lifecycle regressions, not browser, protected-delivery or deployment evidence.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// Private test dependency, deliberately not a runtime/Worker dependency. See acceptance note.
const domModule = pathToFileURL(resolve(process.env.CLEARCASE_VIEWER_DOM ?? '.local/viewer-dom/node_modules/jsdom/lib/api.js')).href;
const { JSDOM } = await import(/* @vite-ignore */ domModule);
// @ts-expect-error The local Vitest config compiles this synthetic harness as a client component.
import Harness from './ViewerHarness.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const note = (id: string, body = `remark-${id}`) => ({ rowId: `note-${id}`, assetId: id, page: 1, body, version: 'v1', current: true });
const data = (assetId = 'A', caseId = 'case-a') => ({ caseId, assetId,
  view: { state: 'available', mode: 'pdf', filename: `${assetId}.pdf`, mediaType: 'application/pdf', size: 123,
    srcHref: `/cases/${caseId}/originals/${assetId}`, downloadHref: `/cases/${caseId}/originals/${assetId}?download=1` },
  notesHref: `/cases/${caseId}/originals/${assetId}/notes`, notes: { state: 'available', items: [note(assetId)] },
});
const reader = () => ({ pages: 3, draw: vi.fn(async () => {}), destroy: vi.fn() });
let dom: any, component: any;
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };
const draft = () => document.querySelector('textarea')!;
const type = (text: string) => { draft().value = text; draft().dispatchEvent(new Event('input', { bubbles: true })); flushSync(); };
const submit = () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync(); };
const reply = (body = 'saved') => new Response(JSON.stringify({ note: note('saved', body) }), { status: 201 });
function start(open = vi.fn(async () => reader())) {
  (window as any).clearcasePdfReader = { open };
  component = mount(Harness, { target: document.body, props: { initial: data() } });
  flushSync();
  return open;
}
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://case.test' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });

it.each([['B', 'case-a'], ['A', 'case-b']])('replaces reader, notes, draft, page and zoom on navigation to %s in %s', async (asset, caseId) => {
  const old = reader(), fresh = reader(), open = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);
  start(open); await settle();
  type('old document draft');
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Next')!.click();
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Zoom in')!.click();
  component.navigate(data(asset, caseId)); flushSync(); await settle();
  expect(old.destroy).toHaveBeenCalledOnce();
  expect(open.mock.calls.map(([a]) => a.src)).toEqual([data().view.srcHref, data(asset, caseId).view.srcHref]);
  expect(document.body.textContent).toContain(`remark-${asset}`);
  if (asset !== 'A') expect(document.body.textContent).not.toContain('remark-A');
  expect(draft().value).toBe('');
  expect(fresh.draw).toHaveBeenLastCalledWith(1, 1.2);
  const fetcher = vi.fn(async () => reply('new original note')); vi.stubGlobal('fetch', fetcher);
  type('new original note'); submit(); await settle();
  expect(fetcher.mock.calls[0]![0]).toBe(data(asset, caseId).notesHref);
});

it('resets even a same-URL server reload (including changed original content) without exposing a hash', async () => {
  const old = reader(), fresh = reader(), open = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);
  start(open); await settle(); type('old content');
  component.navigate({ ...data(), notes: { state: 'available', items: [] } }); flushSync(); await settle();
  expect(old.destroy).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledTimes(2);
  expect(draft().value).toBe(''); expect(document.body.textContent).not.toContain('remark-A');
});

it.each(['resolve', 'reject'] as const)('ignores a late %s from an old pending load', async (outcome) => {
  const held = deferred<ReturnType<typeof reader>>(), old = reader(), fresh = reader();
  const open = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce(fresh);
  start(open); await settle(); component.navigate(data('B')); flushSync(); await settle();
  if (outcome === 'resolve') held.resolve(old); else held.reject(new Error('old failed'));
  await settle();
  expect(document.querySelector('[data-viewer-state]')!.getAttribute('data-viewer-state')).toBe('ready');
  expect(fresh.draw).toHaveBeenCalledWith(1, 1.2);
  if (outcome === 'resolve') { expect(old.destroy).toHaveBeenCalledOnce(); expect(old.draw).not.toHaveBeenCalled(); }
  expect(open.mock.calls[0]![0].signal.aborted).toBe(true);
});

it('ignores a late old draw error after a newer draw or navigation', async () => {
  const held = deferred<void>(), r = reader(); r.draw.mockImplementationOnce(() => held.promise);
  start(vi.fn(async () => r)); await settle();
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Next')!.click(); await settle();
  held.reject(new Error('stale render')); await settle();
  expect(document.querySelector('[data-viewer-state]')!.getAttribute('data-viewer-state')).toBe('ready');
});

it('preserves newer typing and prevents concurrent submissions while a save is held', async () => {
  start(); await settle(); const held = deferred<Response>(), fetcher = vi.fn(() => held.promise); vi.stubGlobal('fetch', fetcher);
  type('submitted'); submit(); type('newer draft'); submit();
  expect(fetcher).toHaveBeenCalledOnce();
  held.resolve(reply('submitted')); await settle();
  expect(draft().value).toBe('newer draft'); expect(document.body.textContent).toContain('submitted');
});

it('clears only the unchanged submitted draft, not text edited away and back', async () => {
  start(); await settle(); const held = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => held.promise));
  type('same text'); submit(); type('other'); type('same text'); held.resolve(reply()); await settle();
  expect(draft().value).toBe('same text');
});

it('clears an unchanged successful draft', async () => {
  start(); await settle(); vi.stubGlobal('fetch', vi.fn(async () => reply()));
  type('saved'); submit(); await settle(); expect(draft().value).toBe('');
});

it('aborts an old save, never merges its completion, and sends the new draft only to the new original', async () => {
  start(); await settle(); const held = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce(reply('new')); vi.stubGlobal('fetch', fetcher);
  type('old'); submit(); component.navigate(data('B')); flushSync(); await settle();
  expect(fetcher.mock.calls[0]![0]).toBe(data().notesHref);
  expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  type('new'); held.resolve(reply('old late saved')); await settle();
  expect(draft().value).toBe('new'); expect(document.body.textContent).not.toContain('old late saved');
  submit(); await settle(); expect(fetcher.mock.calls[1]![0]).toBe(data('B').notesHref);
});

it('shows transport failure, retains draft and reuses only that exact retry operation', async () => {
  start(); await settle(); const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply('first')).mockResolvedValueOnce(reply('second'));
  vi.stubGlobal('fetch', fetcher); type('first'); submit(); await settle();
  expect(document.body.textContent).toContain('The note was not saved.'); expect(draft().value).toBe('first');
  submit(); await settle();
  const bodies = () => fetcher.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(bodies()[0].operationId).toBe(bodies()[1].operationId);
  expect(draft().value).toBe(''); type('second'); submit(); await settle();
  expect(bodies()[2].operationId).not.toBe(bodies()[1].operationId);
});

it('does not reuse a failed operation after changing its page or body', async () => {
  start(); await settle(); const fetcher = vi.fn(async () => new Response('{}', { status: 503 })); vi.stubGlobal('fetch', fetcher);
  type('first'); submit(); await settle(); type('second'); submit(); await settle();
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Next')!.click(); submit(); await settle();
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(new Set(bodies.map((b) => b.operationId)).size).toBe(3); expect(bodies[2].page).toBe(2);
});
