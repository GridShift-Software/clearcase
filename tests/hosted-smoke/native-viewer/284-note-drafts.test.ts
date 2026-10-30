// GRS-284: an unsaved note draft survives what the page does around it, and leaving it asks first. Mounts the real case
// notes page and the shared document page, compiled for the client by this directory's Vitest config, inside
// PageHarness, so an action's answer and a data reload change their props as SvelteKit does. `enhance`,
// `beforeNavigate`, `afterNavigate`, `goto` and `history.go` are doubles that record what the pages send and do, and the
// test plays the app's side. A UI regression, not browser, route-contract or hosted evidence.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';

type Result =
  | { type: 'success' | 'failure'; status: number; data: Record<string, unknown> }
  | { type: 'redirect'; status: number; location: string }
  | { type: 'error'; status?: number; error: { message: string } };
type Nav = { type: string; from: { url: URL }; to: { url: URL } | null; delta?: number; willUnload: boolean; cancel(): void };
type Sent = { action: string; fields: Record<string, string> };

const sent: Sent[] = [];
const native: Sent[] = [];
const guards: ((nav: Nav) => void)[] = [];
const afters: (() => void)[] = [];
const gotos: { to: string; cancelled: boolean }[] = [];
const traversals: { delta: number; cancelled: boolean }[] = [];
const reloads: { to: string; cancelled: boolean }[] = [];
const errorPages: Result[] = [];
let reply: ((r: Result) => void) | null = null;
let reloaded: unknown = null;
let popped = '';
let dom: any, harness: any;

const fieldsOf = (fd: FormData) => Object.fromEntries([...fd].map(([k, v]) => [k, String(v)]));
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 0)); flushSync(); } };

/** A SvelteKit navigation of `type` from this page, through every registered beforeNavigate; true when one cancelled it. */
function navigate(type: string, to: string | null, delta?: number) {
  let cancelled = false;
  if (type === 'popstate') popped = to ?? '';
  const nav: Nav = { type, from: { url: new URL(location.href) }, to: to === null ? null : { url: new URL(to, location.href) }, delta, willUnload: type === 'leave', cancel: () => { cancelled = true; } };
  for (const g of [...guards]) g(nav);
  if (!cancelled && type !== 'leave') for (const a of [...afters]) a();
  flushSync();
  return cancelled;
}

vi.mock('$app/navigation', () => ({
  beforeNavigate: (fn: (nav: Nav) => void) => { guards.push(fn); },
  afterNavigate: (fn: () => void) => { afters.push(fn); },
  goto: vi.fn(async (to: URL | string) => { gotos.push({ to: String(to), cancelled: navigate('goto', String(to)) }); }),
  invalidateAll: vi.fn(async () => {}),
}));
// SvelteKit's side of an enhanced form: the page's submit function decides what is sent; `update` applies a failure or
// success as the page's `form` and follows a redirect with a goto that reloads the page's data (`reloaded`). An error
// is recorded where SvelteKit would replace the page with its error page.
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit?: (input: unknown) => unknown) => {
    const onsubmit = async (e: SubmitEvent) => {
      e.preventDefault();
      const formData = new FormData(form), by = e.submitter as HTMLButtonElement | null, action = new URL(form.action);
      if (by?.name) formData.set(by.name, by.value);
      let cancelled = false;
      const after = await submit?.({ formData, formElement: form, submitter: by, action, cancel: () => { cancelled = true; } });
      if (cancelled) return;
      sent.push({ action: form.getAttribute('action')!, fields: fieldsOf(formData) });
      const result = await new Promise<Result>((resolve) => { reply = resolve; });
      const update = async (o: { reset?: boolean } = {}) => {
        if (result.type === 'success' && o.reset !== false) form.reset();
        if (result.type === 'success' || result.type === 'failure') harness.answer({ form: result.data });
        else if (result.type === 'redirect') {
          const cancelled = navigate('goto', result.location);
          reloads.push({ to: result.location, cancelled });
          if (!cancelled) harness.answer({ data: reloaded, form: null });
        } else errorPages.push(result);
      };
      if (typeof after === 'function') await after({ result, update, formData, formElement: form, action });
      else await update();
    };
    form.addEventListener('submit', onsubmit);
    return { destroy: () => form.removeEventListener('submit', onsubmit) };
  },
}));
const { default: PageHarness } = await import('./PageHarness.svelte');
const { default: DocPage } = await import('../../../src/routes/v/[vid]/doc/[ref]/+page.svelte');
const { default: NotesPage } = await import('../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte');

const RV = `sha256:${'a'.repeat(64)}`, OLD = `sha256:${'b'.repeat(64)}`;
const ORIGIN = 'https://client-a.clearcase.test';
const caseNote = (id: string, version = 'v1') => ({ id, version, body: `Synthetic note ${id}`, createdAt: '2026-11-01', target: { kind: 'case' } });
const notesData = (over: Record<string, unknown> = {}) => ({
  caseId: 'c1', label: 'Synthetic case', caseHref: '/cases/c1', chronologyHref: `/cases/c1/v/${encodeURIComponent(RV)}/chronology`, resultsVersion: RV, operationId: 'op-1', saved: false, deleted: false, canWrite: true,
  notes: { state: 'available', items: [caseNote('n-1'), caseNote('n-2')] }, ...over,
});
const fields = { date: '', dateType: null, dateSource: null, subject: 'Synthetic document', filename: 'synthetic.pdf', docType: '', bundle: '', sender: '', to: '', cc: '', amount: '', invoiceNo: '', size: null, textStatus: '', alsoIn: [], attachmentNames: [], excerpt: '' };
const docNote = (id: string, body = `Synthetic note ${id}`) => ({ id, body, createdAt: '2026-11-01', status: 'here', refAtCreation: 'D-001', candidates: [], intact: true, version: 'v1' });
const doc = {
  ref: 'D-001', source: 'results', version: { id: RV, titleName: 'Synthetic v Example' }, fields, base: '/cases/c1/v', page: null, attachments: [], children: [], related: [], parent: null, onDisk: null, operationId: 'op-1',
  state: { file: 'missing', original: null, self: null, flags: [] }, links: { presentation: null, open: null, download: null, viewer: null }, notes: [docNote('n-1')],
};
const DOC_PATH = `/cases/c1/v/${encodeURIComponent(RV)}/doc/D-001`;

function open(Page: unknown, path: string, data: unknown, form: unknown = null) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${ORIGIN}${path}` });
  for (const key of ['window', 'document', 'location', 'history', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'SubmitEvent', 'FormData', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('addEventListener', dom.window.addEventListener.bind(dom.window));
  vi.stubGlobal('removeEventListener', dom.window.removeEventListener.bind(dom.window));
  vi.spyOn(dom.window.history as History, 'go').mockImplementation((delta = 0) => { traversals.push({ delta, cancelled: navigate('popstate', popped, delta) }); });
  // a native submit is a page load; it is held and recorded here instead of navigating the test window
  document.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const f = e.target as HTMLFormElement, by = (e as SubmitEvent).submitter as HTMLButtonElement | null, fd = new FormData(f);
    if (by?.name) fd.set(by.name, by.value);
    native.push({ action: f.getAttribute('action')!, fields: fieldsOf(fd) });
  });
  harness = mount(PageHarness as never, { target: document.body, props: { Page, data, form } as never });
  flushSync();
}
const respond = async (r: Result) => { expect(reply).not.toBeNull(); const answer = reply!; reply = null; answer(r); await settle(); };
const el = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const row = (id: string) => el(`[data-note="${id}"], [data-note-id="${id}"]`);
const button = (id: string, label: string) => [...(row(id)?.querySelectorAll('button') ?? [])].find((b) => !b.hidden && b.textContent === label) ?? null;
const click = async (b: Element | null) => { expect(b).not.toBeNull(); (b as HTMLButtonElement).click(); await settle(); };
const type = (selector: string, text: string) => { const f = el<HTMLTextAreaElement | HTMLInputElement>(selector)!; f.value = text; f.dispatchEvent(new Event('input', { bubbles: true })); flushSync(); };
const value = (selector: string) => el<HTMLInputElement>(selector)?.value ?? null;
/** What the case notes page's Save would send for the draft. */
const draft = () => ({ body: value('#note-body'), ref: value('#note-ref'), resultsVersion: value('#note-form [name="resultsVersion"]'), operationId: value('#note-form [name="operationId"]') });
const asking = () => el('#lit-ask-q')?.textContent ?? null;

beforeEach(() => {
  for (const list of [sent, native, guards, afters, gotos, traversals, reloads, errorPages]) list.length = 0;
  reply = null; reloaded = null; popped = '';
});
afterEach(async () => {
  if (harness) await unmount(harness);
  harness = null;
  // a Delete unmounted mid-action moves focus on a timer; let it run while the window is still there
  await new Promise((r) => setTimeout(r, 0));
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('the case notes page: a refused draft keeps its text, ref, version and retry identity through Delete, Cancel and a failed, lost or successful delete of another note', async () => {
  // a save whose outcome is unknown, refused after the results moved on: the answer keeps the text, the version the
  // annotation was written against and the operation id to retry under
  const refusal = { op: 'add', body: 'Synthetic draft', ref: 'D-001', resultsVersion: OLD, operationId: 'op-retry', message: 'Your notes are unavailable right now, so this may not have been saved.' };
  open(NotesPage, '/cases/c1/notes', notesData(), refusal);
  type('#note-body', 'Synthetic draft, typed further');
  const kept = { body: 'Synthetic draft, typed further', ref: 'D-001', resultsVersion: OLD, operationId: 'op-retry' };
  expect(draft()).toEqual(kept);

  await click(button('n-1', 'Delete'));
  await click(button('n-1', 'Cancel'));
  expect(sent).toEqual([]);
  expect(draft()).toEqual(kept);

  await click(button('n-1', 'Delete'));
  await click(button('n-1', 'Confirm delete'));
  expect(native).toEqual([]);
  expect(sent).toEqual([{ action: '?/delete', fields: expect.objectContaining({ id: 'n-1', version: 'v1', confirm: 'n-1' }) }]);
  await respond({ type: 'failure', status: 409, data: { op: 'delete', message: 'That note changed on the server since this page loaded, so it was not deleted. Its current text is shown.', current: caseNote('n-1', 'v2'), notes: [caseNote('n-1', 'v2'), caseNote('n-2')] } });
  expect(el('#note-error[data-op="delete"]')?.textContent).toContain('it was not deleted');
  expect(row('n-1')?.getAttribute('data-note-version')).toBe('v2');
  expect(draft()).toEqual(kept);

  await click(button('n-2', 'Delete'));
  await click(button('n-2', 'Confirm delete'));
  await respond({ type: 'error', status: 503, error: { message: 'Synthetic: the service is unavailable.' } });
  expect(errorPages).toEqual([]);
  expect(el('#note-error[data-op="delete"]')).not.toBeNull();
  expect(row('n-2')).not.toBeNull();
  expect(draft()).toEqual(kept);

  // SvelteKit follows the delete's redirect to this page's own ?deleted=1 and reloads its data under a new operation id
  reloaded = notesData({ operationId: 'op-2', deleted: true, notes: { state: 'available', items: [caseNote('n-2')] } });
  await click(button('n-1', 'Delete'));
  await click(button('n-1', 'Confirm delete'));
  expect(sent.at(-1)!.fields).toMatchObject({ id: 'n-1', version: 'v2', confirm: 'n-1' });
  await respond({ type: 'redirect', status: 303, location: '/cases/c1/notes?deleted=1' });
  expect(reloads).toEqual([{ to: '/cases/c1/notes?deleted=1', cancelled: false }]);
  expect(el('[data-note-deleted]')).not.toBeNull();
  expect(row('n-1')).toBeNull();
  expect(draft()).toEqual(kept);
  expect(native).toEqual([]);
});

it('the case notes page: leaving a typed draft asks first; Stay keeps it, Leave discards it and goes on, Back as the same traversal; Save does not ask', async () => {
  open(NotesPage, '/cases/c1/notes', notesData());
  expect(navigate('link', '/cases/c1')).toBe(false);
  type('#note-body', 'Synthetic unsaved note');
  expect(navigate('leave', null)).toBe(true);
  expect(asking()).toBeNull();
  expect(navigate('link', '/cases/c1')).toBe(true);
  expect(asking()).toBe('Your note is not saved. Leave this page and lose it?');
  await click(el('#lit-ask-stay'));
  expect(asking()).toBeNull();
  expect(value('#note-body')).toBe('Synthetic unsaved note');

  expect(navigate('popstate', '/cases/c1', -1)).toBe(true);
  await click(el('#lit-ask-leave'));
  expect(traversals).toEqual([{ delta: -1, cancelled: false }]);
  expect(gotos).toEqual([]);
  expect(value('#note-body')).toBe('');

  type('#note-ref', 'D-002');
  expect(navigate('link', '/cases/c1')).toBe(true);
  await click(el('#lit-ask-leave'));
  expect(gotos).toEqual([{ to: `${ORIGIN}/cases/c1`, cancelled: false }]);
  expect(draft()).toMatchObject({ body: '', ref: '' });

  type('#note-body', 'Synthetic note to save');
  await click(el('#note-save'));
  expect(native).toEqual([]);
  expect(sent.at(-1)).toEqual({ action: '?/add', fields: expect.objectContaining({ body: 'Synthetic note to save', operationId: 'op-1', resultsVersion: RV }) });
  expect(asking()).toBeNull();
  reloaded = notesData({ saved: true, operationId: 'op-2' });
  await respond({ type: 'redirect', status: 303, location: '/cases/c1/notes?saved=1' });
  expect(value('#note-body')).toBe('');
  expect(navigate('leave', null)).toBe(false);
});

it('a lost case-note save keeps the draft and its leave warning until a confirmed save', async () => {
  open(NotesPage, '/cases/c1/notes', notesData());
  type('#note-body', 'Synthetic interrupted save');
  await click(el('#note-save'));
  expect(native).toEqual([]);
  expect(sent.at(-1)?.action).toBe('?/add');
  expect(navigate('leave', null)).toBe(true);
  await respond({ type: 'error', error: { message: 'Synthetic request interrupted' } });
  expect(errorPages).toEqual([]);
  expect(value('#note-body')).toBe('Synthetic interrupted save');
  expect(navigate('link', '/cases/c1')).toBe(true);
  expect(asking()).toBe('Your note is not saved. Leave this page and lose it?');
  await click(el('#lit-ask-stay'));
  expect(draft()).toMatchObject({ body: 'Synthetic interrupted save', operationId: 'op-1' });
});

it('the shared document page: leaving a typed note asks first and a refused save keeps asking; a saved note leaves nothing to ask about; Back goes on as the same traversal', async () => {
  open(DocPage, DOC_PATH, doc);
  type('#note-body', 'Synthetic document draft');
  expect(navigate('link', '/cases/c1/notes')).toBe(true);
  expect(asking()).toBe('Your note is not saved. Leave this page and lose it?');
  await click(el('#lit-ask-stay'));
  expect(value('#note-body')).toBe('Synthetic document draft');
  expect(navigate('link', `${DOC_PATH}?page=2`)).toBe(false);

  await click(el('#note-add'));
  expect(sent).toEqual([{ action: '?/note', fields: expect.objectContaining({ body: 'Synthetic document draft', operationId: 'op-1' }) }]);
  await respond({ type: 'failure', status: 503, data: { body: 'Synthetic document draft', operationId: 'op-1', message: 'The note was not saved: the store is busy or unavailable. Your text is kept; try again.' } });
  expect(value('#note-body')).toBe('Synthetic document draft');
  expect(navigate('link', '/cases/c1/notes')).toBe(true);
  await click(el('#lit-ask-stay'));

  await click(el('#note-add'));
  await respond({ type: 'success', status: 200, data: { saved: true, note: docNote('n-9', 'Synthetic document draft'), operationId: 'op-2' } });
  expect(row('n-9')).not.toBeNull();
  expect(value('#note-body')).toBe('');
  expect(navigate('link', '/cases/c1/notes')).toBe(false);
  expect(navigate('leave', null)).toBe(false);

  type('#note-body', 'Synthetic second draft');
  expect(navigate('popstate', `/cases/c1/v/${encodeURIComponent(RV)}/documents`, -1)).toBe(true);
  await click(el('#lit-ask-leave'));
  expect(traversals).toEqual([{ delta: -1, cancelled: false }]);
  expect(gotos).toEqual([]);
  expect(value('#note-body')).toBe('');
});
