// GRS-280: with JavaScript, a note's Delete asks inline and only Confirm sends the delete, carrying the confirmation for
// that note; Cancel sends nothing and returns focus to Delete. Mounts the real shared document page and the hosted case
// notes page, compiled for the client by this directory's Vitest config. `enhance` is a double that records what the
// page's submit function lets through; this is a UI regression, not browser, route-contract or hosted evidence.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';

type Sent = { action: string; fields: Record<string, string> };
const sent: Sent[] = [];
let settle: ((ok: boolean) => void) | null = null;
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}), beforeNavigate: () => {}, afterNavigate: () => {}, goto: vi.fn(async () => {}) }));
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit?: (input: unknown) => unknown) => {
    const onsubmit = async (e: SubmitEvent) => {
      e.preventDefault();
      const formData = new FormData(form), by = e.submitter as HTMLButtonElement | null;
      if (by?.name) formData.set(by.name, by.value);
      let cancelled = false;
      const after = await submit?.({ formData, formElement: form, submitter: by, action: new URL(form.action), cancel: () => { cancelled = true; } });
      if (cancelled) return;
      sent.push({ action: form.getAttribute('action')!, fields: Object.fromEntries([...formData].map(([k, v]) => [k, String(v)])) });
      const ok = await new Promise<boolean>((resolve) => { settle = resolve; });
      if (typeof after === 'function') await after({ result: ok ? { type: 'success', status: 200 } : { type: 'failure', status: 409 }, update: async () => {} });
    };
    form.addEventListener('submit', onsubmit);
    return { destroy: () => form.removeEventListener('submit', onsubmit) };
  },
}));
const { default: DocPage } = await import('../../../src/routes/v/[vid]/doc/[ref]/+page.svelte');
const { default: NotesPage } = await import('../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte');

const fields = { date: '', dateType: null, dateSource: null, subject: 'Synthetic document', filename: 'synthetic.pdf', docType: '', bundle: '', sender: '', to: '', cc: '', amount: '', invoiceNo: '', size: null, textStatus: '', alsoIn: [], attachmentNames: [], excerpt: '' };
const docNote = (id: string) => ({ id, body: `Synthetic note ${id}`, createdAt: '2026-11-01', status: 'here', refAtCreation: 'D-001', candidates: [], intact: true, version: 'v1' });
const doc = {
  ref: 'D-001', source: 'results', version: { id: `sha256:${'b'.repeat(64)}`, titleName: 'Synthetic v Example' }, fields, base: '/cases/c1/v', page: null, attachments: [], children: [], related: [], parent: null, onDisk: null, operationId: 'op-1',
  state: { file: 'missing', original: null, self: null, flags: [] }, links: { presentation: null, open: null, download: null, viewer: null }, notes: [docNote('n-1'), docNote('n-2')],
};
const caseNotes = { caseId: 'c1', label: 'Synthetic case', caseHref: '/cases/c1', chronologyHref: null, resultsVersion: null, operationId: 'op-1', saved: false, deleted: false, canWrite: true,
  notes: { state: 'available', items: ['n-1', 'n-2'].map((id) => ({ id, version: 'v1', body: `Synthetic note ${id}`, createdAt: '2026-11-01', target: { kind: 'case' } })) } };

let dom: any, component: any;
const tick = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };
const row = (id: string) => document.querySelector(`[data-note="${id}"], [data-note-id="${id}"]`)!;
const button = (id: string, label: string) => [...row(id).querySelectorAll('button')].find((b) => !b.hidden && b.textContent === label) ?? null;
const click = async (b: HTMLButtonElement | null) => { expect(b).not.toBeNull(); b!.click(); await tick(); };
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://client-a.clearcase.test' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'SubmitEvent', 'FormData', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
  sent.length = 0; settle = null;
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });

for (const [page, Page, data, action] of [['the shared document page', DocPage, doc, '?/delnote'], ['the hosted case notes page', NotesPage, caseNotes, '?/delete']] as const) {
  it(`${page}: Delete asks, Cancel sends nothing and returns focus, Confirm sends the delete confirmed for that note`, async () => {
    // a native submit is held here instead of navigating the test window
    document.addEventListener('submit', (e) => { if (!e.defaultPrevented) { e.preventDefault(); const f = e.target as HTMLFormElement, by = (e as SubmitEvent).submitter as HTMLButtonElement | null; const fd = new FormData(f); if (by?.name) fd.set(by.name, by.value); sent.push({ action: f.getAttribute('action')!, fields: Object.fromEntries([...fd].map(([k, v]) => [k, String(v)])) }); } });
    component = mount(Page as never, { target: document.body, props: { data, form: null } as never });
    flushSync();
    await click(button('n-1', 'Delete'));
    expect(sent).toEqual([]);
    expect(row('n-1').querySelector('[data-confirming="n-1"]')?.getAttribute('aria-label')).toBe('Delete this note?');
    expect(document.activeElement?.textContent).toBe('Confirm delete');
    expect(row('n-2').querySelector('[data-confirming]')).toBeNull();

    await click(button('n-1', 'Cancel'));
    expect(sent).toEqual([]);
    expect(row('n-1').querySelector('[data-confirming]')).toBeNull();
    expect(document.activeElement).toBe(button('n-1', 'Delete'));

    await click(button('n-1', 'Delete'));
    await click(button('n-1', 'Confirm delete'));
    expect(sent).toEqual([{ action, fields: expect.objectContaining({ id: 'n-1', version: 'v1', confirm: 'n-1' }) }]);
    expect(sent[0]!.fields).not.toHaveProperty('cancel');
  });
}

it('the shared document page: Delete is off while its confirmed delete is in flight, and a failed delete returns focus to it', async () => {
  component = mount(DocPage as never, { target: document.body, props: { data: doc, form: null } as never });
  flushSync();
  await click(button('n-1', 'Delete'));
  await click(button('n-1', 'Confirm delete'));
  expect(sent).toHaveLength(1);
  expect(button('n-1', 'Delete')?.disabled).toBe(true);
  expect(button('n-2', 'Delete')?.disabled).toBe(false);
  settle!(false); await tick(); await tick();
  expect(button('n-1', 'Delete')?.disabled).toBe(false);
  expect(document.activeElement).toBe(button('n-1', 'Delete'));
});
