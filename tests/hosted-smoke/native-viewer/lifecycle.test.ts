// Compiles and mounts the real route and viewer. Only the reader and HTTP transport are doubles;
// these are lifecycle regressions, not browser, protected-delivery or deployment evidence.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';
import type { WorkVersion } from '../../../src/lib/server/runtime/contracts.ts';
// The local Vitest config compiles this synthetic harness as a client component.
import Harness from './ViewerHarness.svelte';

type Navigation = { type: string; from: { url: URL }; to: { url: URL } | null; willUnload: boolean; delta?: number; cancel(): void };
const guards: ((nav: Navigation) => void)[] = [];
const afters: (() => void)[] = [];
const destinations: string[] = [];
function navigate(type: string, destination: string | null, delta?: number) {
  let cancelled = false;
  const nav = { type, from: { url: new URL(window.location.href) }, to: destination === null ? null : { url: new URL(destination, window.location.href) }, willUnload: type === 'leave', delta, cancel: () => { cancelled = true; } };
  for (const guard of [...guards]) guard(nav);
  flushSync();
  if (!cancelled) for (const after of [...afters]) after();
  return cancelled;
}
vi.mock('$app/navigation', async () => {
  const { onDestroy } = await import('svelte');
  return {
    beforeNavigate: (fn: (nav: Navigation) => void) => { guards.push(fn); onDestroy(() => { guards.splice(guards.indexOf(fn), 1); }); },
    afterNavigate: (fn: () => void) => { afters.push(fn); onDestroy(() => { afters.splice(afters.indexOf(fn), 1); }); },
    goto: vi.fn(async (url: URL) => { if (!navigate('goto', url.href)) destinations.push(url.href); }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const note = (id: string, body = `remark-${id}`) => ({ rowId: `note-${id}`, assetId: id, page: 1, body, version: 'v1' as WorkVersion, current: true });
const data = (assetId = 'A', caseId = 'case-a') => ({ caseId, assetId,
  view: { state: 'available' as const, mode: 'pdf' as const, filename: `${assetId}.pdf`, mediaType: 'application/pdf', size: 123,
    srcHref: `/cases/${caseId}/originals/${assetId}`, downloadHref: `/cases/${caseId}/originals/${assetId}?download=1` },
  notesHref: `/cases/${caseId}/originals/${assetId}/notes`, notes: { state: 'available' as const, items: [note(assetId)] },
});
const reader = () => ({ pages: 3, draw: vi.fn(async () => {}), destroy: vi.fn() });
let dom: any, component: any;
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };
const draft = () => document.querySelector('textarea')!;
const type = (text: string) => { draft().value = text; draft().dispatchEvent(new Event('input', { bubbles: true })); flushSync(); };
const submit = () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync(); };
const press = (label: string) => { [...document.querySelectorAll('button')].find((b) => !b.hidden && b.textContent === label)!.click(); flushSync(); };
/** Delete, then Confirm delete, as a person deletes a page note. */
const confirmDelete = () => { press('Delete'); press('Confirm delete'); };
const reply = (body = 'saved') => new Response(JSON.stringify({ note: note('saved', body) }), { status: 201 });
function start(open = vi.fn(async () => reader())) {
  (window as any).clearcasePdfReader = { open };
  component = mount(Harness, { target: document.body, props: { initial: data() } });
  flushSync();
  return open;
}
beforeEach(() => {
  guards.length = 0; afters.length = 0; destinations.length = 0;
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://case.test/cases/case-a/originals/A/view' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('addEventListener', dom.window.addEventListener.bind(dom.window));
  vi.stubGlobal('removeEventListener', dom.window.removeEventListener.bind(dom.window));
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });

it('opens a requested page and restores it on a fresh load', async () => {
  const r = reader(); (window as any).clearcasePdfReader = { open: vi.fn(async () => r) };
  component = mount(Harness, { target: document.body, props: { initial: { ...data(), requestedPage: '2' } } });
  flushSync(); await settle();
  expect(r.draw).toHaveBeenLastCalledWith(2, 1.2);
  expect(document.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('2');
  component.navigate({ ...data(), requestedPage: '2' }); flushSync(); await settle();
  expect(r.draw).toHaveBeenLastCalledWith(2, 1.2);
});

it.each(['0', '-1', '1.5', '4', 'abc', ''])('shows an explicit error for invalid requested page %s', async (requestedPage) => {
  const r = reader(); (window as any).clearcasePdfReader = { open: vi.fn(async () => r) };
  component = mount(Harness, { target: document.body, props: { initial: { ...data(), requestedPage } } });
  flushSync(); await settle();
  expect(r.draw).toHaveBeenLastCalledWith(1, 1.2);
  expect(document.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('1');
  expect(document.querySelector('[role=alert]')?.textContent).toContain('3 pages');
});

it('uses a valid page field value for drawing and page notes', async () => {
  const r = reader(); start(vi.fn(async () => r)); await settle();
  const input = document.querySelector<HTMLInputElement>('input[type=number]')!;
  input.value = '3'; input.dispatchEvent(new Event('change', { bubbles: true })); flushSync(); await settle();
  expect(r.draw).toHaveBeenLastCalledWith(3, 1.2);
  expect(document.body.textContent).toContain('Note on page 3');
});

it('rejects an impossible page field value with feedback and restores the current page', async () => {
  const r = reader(); r.pages = 1; start(vi.fn(async () => r)); await settle();
  const input = document.querySelector<HTMLInputElement>('input[type=number]')!;
  input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
  expect(input.value).toBe('1');
  expect(document.querySelector('[role=alert]')?.textContent).toContain('1 page');
  expect(r.draw).toHaveBeenLastCalledWith(1, 1.2);
});

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
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init: RequestInit) => reply('new original note')); vi.stubGlobal('fetch', fetcher);
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

it.each(['link', 'form'])('guards a page-note draft on %s navigation: Stay preserves it and explicit Discard leaves', async (kind) => {
  start(); await settle(); type('Synthetic unsaved page note'); draft().focus();
  expect(navigate(kind, '/cases')).toBe(true);
  expect(document.querySelector('[role=alertdialog]')?.textContent).toContain('page note');
  press('Stay on this page');
  expect(draft().value).toBe('Synthetic unsaved page note');
  expect(document.activeElement).toBe(draft());
  expect(destinations).toEqual([]);
  expect(navigate(kind, '/cases')).toBe(true);
  press('Leave and discard it'); await settle();
  expect(destinations).toEqual(['https://case.test/cases']);
  expect(draft().value).toBe('');
});

it('guards a same-path requested-page load because the original route remounts the viewer', async () => {
  start(); await settle(); type('Synthetic draft before query navigation');
  expect(navigate('link', '/cases/case-a/originals/A/view?page=2')).toBe(true);
  press('Stay on this page');
  expect(draft().value).toBe('Synthetic draft before query navigation');
});

it('guards reload and closing the tab through SvelteKit leave cancellation', async () => {
  start(); await settle(); type('Synthetic draft before unload');
  expect(navigate('leave', null)).toBe(true);
  expect(document.querySelector('[role=alertdialog]')).toBeNull();
  expect(draft().value).toBe('Synthetic draft before unload');
});

it('discards a draft on Back by preserving the history traversal', async () => {
  start(); await settle(); type('Synthetic draft before Back');
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  expect(navigate('popstate', '/cases', -1)).toBe(true);
  press('Leave and discard it');
  expect(go).toHaveBeenCalledWith(-1);
  expect(destinations).toEqual([]);
  expect(draft().value).toBe('');
});

it('keeps guarding an in-flight or failed save without retiring its retry identity', async () => {
  start(); await settle(); const held = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce(reply()); vi.stubGlobal('fetch', fetcher);
  type('Synthetic retry draft'); submit();
  expect(navigate('link', '/cases')).toBe(true); press('Stay on this page');
  held.reject(new Error('Synthetic interrupted response')); await settle();
  expect(navigate('link', '/cases')).toBe(true); press('Stay on this page');
  expect(draft().value).toBe('Synthetic retry draft');
  submit(); await settle();
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).operationId).toBe(JSON.parse(fetcher.mock.calls[1]![1].body).operationId);
  expect(draft().value).toBe('');
  expect(navigate('link', '/cases')).toBe(false);
});

it('still guards newer typing after an earlier save succeeds, but not an empty composer', async () => {
  start(); await settle(); expect(navigate('link', '/cases')).toBe(false);
  const held = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => held.promise));
  type('Submitted text'); submit(); type('Newer unsaved text'); held.resolve(reply('Submitted text')); await settle();
  expect(navigate('link', '/cases')).toBe(true); press('Stay on this page');
  expect(draft().value).toBe('Newer unsaved text');
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

it('cleans up an adapter script still loading when its original is replaced', async () => {
  component = mount(Harness, { target: document.body, props: { initial: data() } }); flushSync(); await settle();
  const script = document.querySelector('script')!;
  expect(script.src).toContain('/pdfjs/pdf-reader.mjs');
  const fresh = reader(), open = vi.fn(async () => fresh); (window as any).clearcasePdfReader = { open };
  component.navigate(data('B')); flushSync(); await settle();
  expect(script.isConnected).toBe(false);
  window.dispatchEvent(new Event('clearcase:pdf-reader')); await settle();
  expect(open).toHaveBeenCalledOnce();
});

it('does not merge a response whose JSON body settles after navigation', async () => {
  start(); await settle(); const json = deferred<unknown>();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => json.promise })));
  type('old'); submit(); await settle(); component.navigate(data('B')); flushSync(); await settle(); type('new');
  json.resolve({ note: note('old', 'late JSON') }); await settle();
  expect(draft().value).toBe('new'); expect(document.body.textContent).not.toContain('late JSON');
});

it('aborts a pending delete and ignores its completion after navigation', async () => {
  start(); await settle(); const held = deferred<Response>(), fetcher = vi.fn(() => held.promise); vi.stubGlobal('fetch', fetcher);
  confirmDelete();
  component.navigate(data('B')); flushSync(); await settle(); held.resolve(new Response('{}')); await settle();
  expect(document.body.textContent).toContain('remark-B');
  expect((fetcher.mock.calls as any)[0][1].signal.aborted).toBe(true);
});

it('retries a failed delete with the same operation and keeps the note until success', async () => {
  start(); await settle(); const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  confirmDelete(); await settle(); expect(document.body.textContent).toContain('remark-A');
  confirmDelete(); await settle(); expect(document.body.textContent).not.toContain('remark-A');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).operationId).toBe(JSON.parse(fetcher.mock.calls[1]![1].body).operationId);
});

it('asks before deleting a page note: Cancel sends nothing and keeps the draft, Confirm sends the delete confirmed for that note', async () => {
  start(); await settle(); const fetcher = vi.fn(async () => new Response('{"removed":true}')); vi.stubGlobal('fetch', fetcher);
  type('unrelated draft');
  press('Delete'); await settle();
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.querySelector('[data-confirming="note-A"]')?.getAttribute('aria-label')).toBe('Delete this note?');
  expect(document.activeElement?.textContent).toBe('Confirm delete');
  press('Cancel'); await settle();
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.querySelector('[data-confirming]')).toBeNull();
  expect(document.body.textContent).toContain('remark-A'); expect(draft().value).toBe('unrelated draft');
  confirmDelete(); await settle();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse((fetcher.mock.calls as any)[0][1].body)).toEqual({ rowId: 'note-A', version: 'v1', operationId: expect.stringMatching(/^note-/), confirm: 'note-A' });
  expect(document.body.textContent).not.toContain('remark-A'); expect(draft().value).toBe('unrelated draft');
});

it('does not reuse a failed operation after changing its page or body', async () => {
  start(); await settle(); const fetcher = vi.fn(async (_url: RequestInfo | URL, _init: RequestInit & { body: string }) => new Response('{}', { status: 503 })); vi.stubGlobal('fetch', fetcher);
  type('first'); submit(); await settle(); type('second'); submit(); await settle();
  // GRS-288: a note goes only to a drawn page, so page 2 draws before the third save.
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Next')!.click(); await settle(); submit(); await settle();
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(new Set(bodies.map((b) => b.operationId)).size).toBe(3); expect(bodies[2].page).toBe(2);
});
