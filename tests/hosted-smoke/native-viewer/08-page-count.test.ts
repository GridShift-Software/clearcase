// GRS-251: the served pdf.js worker checks the last page after drawing the first, so a malformed /Count can be corrected
// after the viewer opens. The reader then calls `onPages`; the viewer must drop the phantom pages from its counter and
// its navigation. The real route and viewer are compiled and mounted; only the reader is a double.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';
import Harness from './ViewerHarness.svelte';

vi.mock('$app/navigation', () => ({ beforeNavigate: () => {}, afterNavigate: () => {}, goto: vi.fn(async () => {}) }));

const data = { caseId: 'case-a', assetId: 'A',
  view: { state: 'available' as const, mode: 'pdf' as const, filename: 'A.pdf', mediaType: 'application/pdf', size: 123,
    srcHref: '/cases/case-a/originals/A', downloadHref: '/cases/case-a/originals/A?download=1' },
  notesHref: '/cases/case-a/originals/A/notes', notes: { state: 'available' as const, items: [] },
};
let dom: any, component: any;
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://case.test' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('addEventListener', dom.window.addEventListener.bind(dom.window));
  vi.stubGlobal('removeEventListener', dom.window.removeEventListener.bind(dom.window));
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });

it('drops phantom pages when the reader corrects the page count after opening', async () => {
  let onPages: ((pages: number) => void) | undefined;
  const r = { pages: 10, draw: vi.fn(async () => {}), destroy: vi.fn() };
  (window as any).clearcasePdfReader = { open: vi.fn(async (a: { onPages?: (pages: number) => void }) => { onPages = a.onPages; return r; }) };
  component = mount(Harness, { target: document.body, props: { initial: { ...data, requestedPage: '5' } } });
  flushSync(); await settle();
  expect(r.draw).toHaveBeenLastCalledWith(5, 1.2);
  expect(document.body.textContent).toContain('of 10');

  expect(onPages).toBeTypeOf('function');
  onPages!(3); flushSync(); await settle();
  const input = document.querySelector<HTMLInputElement>('input[type=number]')!;
  expect(document.body.textContent).toContain('of 3');
  expect(input.max).toBe('3');
  // The page shown no longer exists: the viewer moves to the last real page and draws it.
  expect(input.value).toBe('3');
  expect(r.draw).toHaveBeenLastCalledWith(3, 1.2);
  expect(document.querySelector<HTMLButtonElement>('button:nth-of-type(2)')!.disabled).toBe(true);
  input.value = '4'; input.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('3 pages');
  expect(r.draw).toHaveBeenLastCalledWith(3, 1.2);
});
