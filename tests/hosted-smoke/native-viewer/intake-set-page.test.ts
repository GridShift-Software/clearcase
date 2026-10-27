// U16: the real client intake page with several PDFs picked at once. It opens one set, stores each file on its own with its
// own progress and error, retries only the failed file, then seals the set and shows the sealed state. Only fetch and
// invalidateAll are doubles; this is UI evidence over jsdom, not browser, route-contract or hosted evidence.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';
import Page from '../../../deploy/client/routes/client/intake/[caseId]/+page.svelte';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }));

const CASE = 'case-a', SETS = `/client/intake/${CASE}/sets`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% SYNTHETIC ONLY ${tag}\n%%EOF\n`);
const pdfFile = (name: string) => { const bytes = pdf(name); return { file: new File([bytes], name, { type: 'application/pdf' }), bytes, name }; };

type Sent = { method: string; url: string; body: unknown };
let dom: any, component: any, sent: Sent[], failPut: Set<string>, sealSteps: number, stored: Set<string>;
const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const input = () => document.querySelector('input[type=file]') as HTMLInputElement;
const pick = (files: File[]) => { Object.defineProperty(input(), 'files', { configurable: true, value: files }); input().dispatchEvent(new Event('change', { bubbles: true })); flushSync(); };
const submit = () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync(); };
const stages = () => Object.fromEntries([...document.querySelectorAll('[data-file]')].map((li) => [li.getAttribute('data-file'), li.getAttribute('data-file-stage')]));
const setState = () => document.querySelector('[data-set-state]')?.getAttribute('data-set-state');
const json = (s: Sent) => JSON.parse(s.body as string) as Record<string, unknown>;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://client-a.clearcase.test' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
  sent = []; failPut = new Set(); sealSteps = 0; stored = new Set();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    sent.push({ method, url, body: init.body });
    const set = { setId: 'x', state: 'open', fileCount: 3, totalBytes: 0, declared: 0, stored: stored.size, finalized: 0, filesSha256: null, revision: null };
    if (method === 'POST' && url === SETS) return reply(201, { set });
    if (method === 'GET' && url.startsWith(`${SETS}/`)) return reply(200, { set, files: [], next: null });
    if (method === 'POST' && url.endsWith('/files')) return reply(201, { stage: 'received' });
    if (method === 'PUT') {
      const op = url.split('/').pop()!;
      if (failPut.delete(op)) return reply(503, { code: 'storage-unavailable', message: 'File storage is unavailable. Try again with the same upload.' });
      stored.add(op);
      return reply(201, { stage: 'stored' });
    }
    if (method === 'POST' && url.endsWith('/seal')) {
      sealSteps++;
      return sealSteps < 2 ? reply(202, { set: { ...set, state: 'sealing', finalized: 2 } })
        : reply(201, { set: { ...set, state: 'sealed', finalized: 3, filesSha256: json(sent.at(-1)!).filesSha256, revision: { revisionId: 'subrev-x', sequence: 4 } } });
    }
    return reply(404, { code: 'not-found' });
  }));
  component = mount(Page, { target: document.body, props: { data: { caseId: CASE, available: true, submissions: [], sets: [] } } });
  flushSync();
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });

it('opens one set for the picked PDFs, stores each with its own progress, retries only the failed one, then seals it', async () => {
  const fs = [pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf')];
  expect(input().multiple).toBe(true);
  pick(fs.map((f) => f.file));
  expect(Object.keys(stages())).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  submit();
  await vi.waitFor(() => expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(3));
  const declared = sent.filter((s) => s.method === 'POST' && s.url.endsWith('/files')).map(json);
  const opOf = Object.fromEntries(declared.map((d) => [d.path, d.operationId as string]));
  const open = json(sent.find((s) => s.method === 'POST' && s.url === SETS)!);
  expect(open).toEqual({ setId: expect.stringMatching(/^set-[0-9a-f]{40}$/), fileCount: 3, totalBytes: fs.reduce((n, f) => n + f.bytes.byteLength, 0) });
  expect(declared.map((d) => [d.path, d.size, d.sha256])).toEqual(fs.map((f) => [f.name, f.bytes.byteLength, sha(f.bytes)]));
  await vi.waitFor(() => expect(setState()).toBe('sealed'));
  expect(sent.filter((s) => s.url.endsWith('/seal')).map((s) => json(s).filesSha256)).toEqual(Array(2).fill(await fileSetDigest(fs.map((f) => ({ path: f.name, size: f.bytes.byteLength, sha256: sha(f.bytes) })))));
  expect(Object.values(opOf)).toHaveLength(3);
});

it('shows a failed file with its own error, keeps the set open, and retries only that file', async () => {
  const fs = [pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf')];
  pick(fs.map((f) => f.file));
  // Fail b.pdf's first store: its operation id is only known once declared, so fail by path through the declaration.
  const realFetch = fetch as unknown as ReturnType<typeof vi.fn>, inner = realFetch.getMockImplementation()!;
  let failed = false;
  realFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT' && !failed) {
      const declaredB = sent.filter((s) => s.method === 'POST' && s.url.endsWith('/files')).map(json).find((d) => d.path === 'b.pdf');
      if (declaredB && url.endsWith(String(declaredB.operationId))) { failed = true; failPut.add(String(declaredB.operationId)); }
    }
    return inner(url, init);
  });
  submit();
  await vi.waitFor(() => expect(stages()).toEqual({ 'a.pdf': 'stored', 'b.pdf': 'failed', 'c.pdf': 'stored' }));
  expect(document.querySelector('[data-file="b.pdf"]')!.textContent).toContain('File storage is unavailable');
  expect(sent.some((s) => s.url.endsWith('/seal'))).toBe(false);
  expect(setState()).toBe('open');
  const putsBefore = sent.filter((s) => s.method === 'PUT').length;
  const retry = document.querySelector('button[data-retry]') as HTMLButtonElement;
  expect(retry).toBeTruthy();
  retry.click(); flushSync();
  await vi.waitFor(() => expect(setState()).toBe('sealed'));
  const retried = sent.filter((s) => s.method === 'PUT').slice(putsBefore);
  expect(retried).toHaveLength(1);
  expect(new Uint8Array(await new Response(retried[0]!.body as BodyInit).arrayBuffer())).toEqual(fs[1]!.bytes);
  expect(stages()).toEqual({ 'a.pdf': 'stored', 'b.pdf': 'stored', 'c.pdf': 'stored' });
  expect(document.querySelector('[data-set-state="sealed"]')!.textContent).toMatch(/Sealed.*3 files.*submission 4/s);
});

it('keeps one picked file on the single-file route', async () => {
  const f = pdfFile('only.pdf');
  pick([f.file]);
  submit();
  await vi.waitFor(() => expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(1));
  const op = (JSON.parse(sent[0]!.body as string) as { operationId: string }).operationId;
  expect(sent.map((s) => [s.method, s.url])).toEqual([['POST', `/client/intake/${CASE}/submissions`], ['PUT', `/client/intake/${CASE}/submissions/${op}`]]);
});
