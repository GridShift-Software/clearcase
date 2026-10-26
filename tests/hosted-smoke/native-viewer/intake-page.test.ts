// Mounts the real client intake page (compiled for the client by this directory's Vitest config) with a File whose
// arrayBuffer() the test releases by hand, so a second pick can land while the first file's bytes are still being read.
// Only fetch and invalidateAll are doubles; this is a UI race regression, not browser, route-contract or hosted evidence.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';
import Page from '../../../deploy/client/routes/client/intake/[caseId]/+page.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }));

const CASE = 'case-a', BASE = `/client/intake/${CASE}/submissions`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% SYNTHETIC ONLY ${tag}\n%%EOF\n`);

/** A synthetic PDF File. `hold()` makes its arrayBuffer() wait for `release()`, after the call has already started. */
function pdfFile(name: string, tag: string) {
  const bytes = pdf(tag), file = new File([bytes], name, { type: 'application/pdf' });
  let release!: () => void, gate: Promise<void> | null = null, started = 0;
  const real = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { started++; const read = real(); if (gate) await gate; return read; };
  return { file, bytes, name, get started() { return started; }, hold() { gate = new Promise<void>((yes) => { release = yes; }); }, release: () => release() };
}
type Sent = { method: string; url: string; body: unknown };
let dom: any, component: any, sent: Sent[], putStatus: number[];
const put = (...statuses: number[]) => { putStatus = statuses; };
const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const input = () => document.querySelector('input[type=file]') as HTMLInputElement;
const pick = (file: File) => { Object.defineProperty(input(), 'files', { configurable: true, value: [file] }); input().dispatchEvent(new Event('change', { bubbles: true })); flushSync(); };
const submit = () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync(); };
const status = () => document.querySelector('[role=status]')!.textContent;
const metas = () => sent.filter((s) => s.method === 'POST').map((s) => JSON.parse(s.body as string) as { operationId: string; path: string; size: number; sha256: string; mediaType: string });
const puts = () => sent.filter((s) => s.method === 'PUT').map((s) => ({ url: s.url, bytes: new Uint8Array(s.body as ArrayBuffer) }));
const settled = (n: number) => vi.waitFor(() => expect(sent.filter((s) => s.method === 'PUT').length).toBeGreaterThanOrEqual(n));

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://client-a.clearcase.test' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
  sent = []; putStatus = [200];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ method: init.method!, url, body: init.body });
    if (init.method === 'POST') return reply(201, { kind: 'declared' });
    const status = putStatus.length > 1 ? putStatus.shift()! : putStatus[0]!;
    return status === 200 ? reply(200, { stage: 'finalized' }) : reply(status, { message: 'The store is unavailable.' });
  }));
  component = mount(Page, { target: document.body, props: { data: { caseId: CASE, available: true, submissions: [] } } });
  flushSync();
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });

it('sends the file that was selected when Send was pressed, though the picker moves on while its bytes are read', async () => {
  const first = pdfFile('first.pdf', 'one'), second = pdfFile('second.pdf', 'two');
  first.hold();
  pick(first.file); submit();
  expect(first.started).toBe(1);
  pick(second.file);
  first.release();
  await settled(1);
  expect(metas()).toEqual([{ operationId: expect.any(String), path: 'first.pdf', size: first.bytes.byteLength, sha256: sha(first.bytes), mediaType: 'application/pdf' }]);
  expect(puts()).toEqual([{ url: `${BASE}/${metas()[0]!.operationId}`, bytes: first.bytes }]);
  await vi.waitFor(() => expect(status()).toBe('Finalized. No results yet.'));
});

it('treats the later pick as its own upload: new operation, its own name, bytes and hash, never the first one\'s', async () => {
  const first = pdfFile('first.pdf', 'one'), second = pdfFile('second.pdf', 'two');
  first.hold();
  pick(first.file); submit();
  pick(second.file);
  first.release();
  await settled(1);
  await vi.waitFor(() => expect(status()).toBe('Finalized. No results yet.'));
  expect(second.started).toBe(0);
  submit();
  await settled(2);
  const [a, b] = metas();
  expect(a).toMatchObject({ path: 'first.pdf', size: first.bytes.byteLength, sha256: sha(first.bytes) });
  expect(b).toEqual({ operationId: expect.any(String), path: 'second.pdf', size: second.bytes.byteLength, sha256: sha(second.bytes), mediaType: 'application/pdf' });
  expect(b!.operationId).not.toBe(a!.operationId);
  expect(puts()[1]).toEqual({ url: `${BASE}/${b!.operationId}`, bytes: second.bytes });
});

it('retries the captured first file under its own operation, and a different pick under another', async () => {
  const first = pdfFile('first.pdf', 'one'), second = pdfFile('second.pdf', 'two');
  put(503, 200, 200);
  first.hold();
  pick(first.file); submit();
  pick(second.file);
  first.release();
  await settled(1);
  await vi.waitFor(() => expect(status()).toBe('The store is unavailable.'));
  pick(first.file); submit();
  await settled(2);
  pick(second.file); submit();
  await settled(3);
  const [a, retry, other] = metas();
  expect(a).toMatchObject({ path: 'first.pdf', size: first.bytes.byteLength, sha256: sha(first.bytes) });
  expect(retry).toEqual(a);
  expect(other).toMatchObject({ path: 'second.pdf', size: second.bytes.byteLength, sha256: sha(second.bytes) });
  expect(other!.operationId).not.toBe(a!.operationId);
  expect(puts().map((p) => p.bytes)).toEqual([first.bytes, first.bytes, second.bytes]);
  expect(puts().map((p) => p.url)).toEqual([a, retry, other].map((m) => `${BASE}/${m!.operationId}`));
});
