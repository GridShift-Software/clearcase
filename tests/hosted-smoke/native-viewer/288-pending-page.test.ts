// GRS-288: on staging a jump to page 1000 of a large original stayed unrendered for over a minute while the old page stayed
// on screen, and the page box, the canvas label and the note form already named page 1000 with Save enabled, so a note
// could land on a page the reader had not seen. The real route and viewer are compiled and mounted; only the reader and
// the notes endpoint are doubles, and each draw is held until the test lets it finish. Component evidence, not a browser run.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';
import Harness from './ViewerHarness.svelte';

function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const data = { caseId: 'case-a', assetId: 'A',
  view: { state: 'available' as const, mode: 'pdf' as const, filename: 'A.pdf', mediaType: 'application/pdf', size: 123,
    srcHref: '/cases/case-a/originals/A', downloadHref: '/cases/case-a/originals/A?download=1' },
  notesHref: '/cases/case-a/originals/A/notes', notes: { state: 'available' as const, items: [] },
};
let dom: any, component: any, held: Map<number, ReturnType<typeof deferred>[]>, onPages: ((n: number) => void) | undefined;
const settle = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); flushSync(); } };
/** A reader of `pages` pages whose draws of the pages in `hold` wait until the test settles them. */
function reader(pages: number, hold: number[] = []) {
  const r = { pages, destroy: vi.fn(), draw: vi.fn((n: number) => {
    if (!hold.includes(n)) return Promise.resolve();
    const d = deferred();
    held.set(n, [...(held.get(n) ?? []), d]);
    return d.promise;
  }) };
  (window as any).clearcasePdfReader = { open: vi.fn(async (a: { onPages?: (n: number) => void }) => { onPages = a.onPages; return r; }) };
  return r;
}
const release = async (page: number, outcome: 'resolve' | 'reject' = 'resolve') => {
  for (const d of held.get(page) ?? []) outcome === 'resolve' ? d.resolve() : d.reject(new Error('render failed'));
  held.delete(page);
  await settle();
};
const canvas = () => document.querySelector<HTMLCanvasElement>('canvas[data-testid="pdf-page"]')!;
const save = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save note')!;
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)!;
const status = () => document.querySelector('[role=status]')?.textContent ?? '';
const enter = (page: number) => {
  const input = document.querySelector<HTMLInputElement>('input[type=number]')!;
  input.value = String(page); input.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
};
const type = (text: string) => {
  const area = document.querySelector('textarea')!;
  area.value = text; area.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
};
const submit = () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync(); };
const saved = () => new Response(JSON.stringify({ note: { rowId: 'note-1', assetId: 'A', page: 1, body: 'x', version: 'v1', current: true } }), { status: 201 });
/** The page the reader can see: the canvas is visible and says which page it holds. */
function showing(page: number) {
  expect(canvas().style.visibility).not.toBe('hidden');
  expect(canvas().getAttribute('aria-label')).toBe(`Page ${page}`);
  expect(status()).not.toContain('Loading');
}
/** A page asked for but not drawn: the old drawing is hidden, the wait is said, and no note can be saved to it. */
function pending(page: number) {
  expect(canvas().style.visibility).toBe('hidden');
  expect(status()).toContain(`Loading page ${page}`);
  expect(save().disabled).toBe(true);
}
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://case.test' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
  held = new Map(); onPages = undefined;
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });
const start = async (requestedPage: string | null = null) => {
  component = mount(Harness, { target: document.body, props: { initial: { ...data, requestedPage } } });
  flushSync(); await settle();
};

it('hides the old page and refuses a note while a distant page is still drawing, then saves to that page once drawn', async () => {
  reader(1200, [1000]); await start();
  showing(1); expect(save().disabled).toBe(false);
  const fetcher = vi.fn(async () => saved()); vi.stubGlobal('fetch', fetcher);
  type('a note for the page on screen');
  enter(1000); await settle();
  pending(1000);
  submit(); await settle();
  expect(fetcher).not.toHaveBeenCalled();
  await release(1000);
  showing(1000); expect(save().disabled).toBe(false);
  submit(); await settle();
  expect(JSON.parse((fetcher.mock.calls as any)[0][1].body).page).toBe(1000);
});

it('lets neither a superseded draw nor a later page turn authorize a save', async () => {
  reader(1200, [1, 2, 3, 1000]); await start();
  await release(1); showing(1);
  const fetcher = vi.fn(async () => saved()); vi.stubGlobal('fetch', fetcher);
  type('draft');
  enter(1000); await settle(); pending(1000);
  // Back to page 1 before page 1000 arrives: the late page 1000 draw must not count as page 1 on screen.
  enter(1); await settle(); pending(1);
  await release(1000); pending(1);
  submit(); await settle(); expect(fetcher).not.toHaveBeenCalled();
  await release(1); showing(1);
  // Quick turns: only the last page asked for, once drawn, takes notes.
  button('Next').click(); flushSync(); button('Next').click(); flushSync(); await settle();
  pending(3);
  await release(2); pending(3);
  submit(); await settle(); expect(fetcher).not.toHaveBeenCalled();
  await release(3); showing(3);
  submit(); await settle();
  expect(JSON.parse((fetcher.mock.calls as any)[0][1].body).page).toBe(3);
});

it('keeps the drawn page on screen and saveable while it is redrawn at another zoom, but not while another page is pending', async () => {
  const r = reader(1200, [1000]); await start();
  r.draw.mockImplementationOnce(() => new Promise<void>(() => {}));
  button('Zoom in').click(); flushSync(); await settle();
  showing(1); expect(save().disabled).toBe(false);
  enter(1000); await settle(); pending(1000);
  button('Zoom out').click(); flushSync(); await settle();
  pending(1000);
});

it('refuses a note when the page draw fails, and when the viewer goes away mid-draw', async () => {
  reader(1200, [1000]); await start();
  const fetcher = vi.fn(async () => saved()); vi.stubGlobal('fetch', fetcher);
  type('draft'); enter(1000); await settle();
  await release(1000, 'reject');
  expect(document.querySelector('[data-viewer-state]')!.getAttribute('data-viewer-state')).toBe('error');
  submit(); await settle();
  expect(save().disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  await unmount(component); component = null;
  await settle(); expect(fetcher).not.toHaveBeenCalled();
});

it('treats the last real page as pending after a count correction moves the viewer to it', async () => {
  reader(10, [3]); await start('5');
  showing(5);
  onPages!(3); flushSync(); await settle();
  pending(3);
  await release(3); showing(3); expect(save().disabled).toBe(false);
});
