// GRS-282: the shared chronology page, client-compiled in real Chromium inside the case shell, over invented rows shaped
// like a published version's list: three pages in package order, the dated rows first and the undated ones last. The
// whole-list fetch waits until the test lets it answer, so what the page shows before it is seen. Inert Kit hooks stand in
// for navigation; this is not hosted acceptance.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { facetsOf } from '../../src/lib/local-case/chronology.ts';
import type { ChronologyListRow } from '../../src/lib/local-case/model.ts';
// @ts-expect-error the repository's CDP driver is JavaScript without declarations.
import { launch, newPage } from '../e2e/pilot/lib/cdp.mjs';

const DATED = 420, UNDATED = 30;
const ref = (i: number) => `SX-${String(i).padStart(4, '0')}`;
const day = (i: number) => new Date(Date.UTC(2001, 0, 1 + i)).toISOString().slice(0, 10);
const rows: ChronologyListRow[] = Array.from({ length: DATED + UNDATED }, (_, i) => ({
  ref: ref(i), ord: i, date: i < DATED ? day(i) : '', dateType: null, dateSource: null, docType: i % 3 ? 'letter' : 'correspondence', bundle: i % 2 ? 'Bulk A' : 'Correspondence',
  subject: `Invented subject number ${i} about a synthetic matter`, filename: `${ref(i)}.pdf`, sender: '', to: '', excerpt: '', amount: i % 5 ? '' : '12345.67', alsoIn: [], url: '',
  textStatus: i % 4 ? 'extracted' : 'none', parentRef: null, file: 'present', preview: 'inline-isolated', attachments: 0,
}));
const RV = `sha256:${'c'.repeat(64)}`;
const data = { version: { id: RV, caseId: 'synthetic', titleName: 'Synthetic matter' }, base: '/v', exportName: { name: 'chronology.csv', note: null }, listHref: '/synthetic-list',
  facets: facetsOf(rows), first: { page: 1, pages: 3, total: rows.length, rows: rows.slice(0, 200) }, failed: [] };
const shell = { brand: 'ClearCase', caseName: 'Synthetic matter', base: '/v', resultsVersion: RV, current: 'chronology', published: { label: 'Published', at: null, documents: rows.length },
  searchHref: '/search', account: null, actions: [] };

let scratch: string, server: ViteDevServer, browser: any, page: any, origin: string;

beforeAll(async () => {
  const root = process.cwd();
  await mkdir(path.join(root, '.local'), { recursive: true });
  scratch = await mkdtemp(path.join(root, '.local/11-chronology-'));
  await writeFile(path.join(scratch, 'Harness.svelte'), `<script>
    import AppShell from '${root}/src/lib/components/AppShell.svelte';
    import Page from '${root}/src/routes/v/[vid]/chronology/+page.svelte';
    import '${root}/src/app.css';
    const data = ${JSON.stringify(data)}, shell = ${JSON.stringify(shell)};
  </script>
  {#snippet original(ref)}<p class="pane-state" data-pane-state="synthetic">Original of {ref}</p>{/snippet}
  <AppShell {shell}>
    {#snippet sidebar()}<nav class="views" aria-label="Case views"><a href="#overview">Overview</a></nav>{/snippet}
    <Page {data} {original} />
  </AppShell>`);
  await writeFile(path.join(scratch, 'all.json'), JSON.stringify(rows));
  // The whole list answers only once the test calls __releaseList().
  await writeFile(path.join(scratch, 'main.js'), `import { mount } from 'svelte'; import App from './Harness.svelte'; import all from './all.json';
    let release; const gate = new Promise((r) => { release = r; }); window.__releaseList = () => release();
    const real = window.fetch.bind(window);
    window.fetch = (u, o) => String(u).startsWith('/synthetic-list') ? gate.then(() => new Response(JSON.stringify(all), { headers: { 'content-type': 'application/json' } })) : real(u, o);
    mount(App, { target: document.body });`);
  await writeFile(path.join(scratch, 'kit.js'), `export const page = { get url() { return new URL(location.href); }, state: {} };
    export const replaceState = (url, state) => history.replaceState(state, '', url);
    export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const goto = async () => {}; export const invalidateAll = async () => {};
    export const applyAction = async () => {}; export const enhance = () => ({ destroy() {} }); export const deserialize = (t) => JSON.parse(t);`);
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script type="module" src="/@fs/${scratch}/main.js"></script></body></html>`;
  server = await createServer({ configFile: false, root, logLevel: 'error',
    plugins: [svelte({ configFile: false }), { name: '11-chronology-entry', configureServer(s) {
      s.middlewares.use('/chronology', (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
    } }],
    resolve: { alias: { $lib: path.join(root, 'src/lib'), '$app/forms': path.join(scratch, 'kit.js'), '$app/navigation': path.join(scratch, 'kit.js'), '$app/state': path.join(scratch, 'kit.js') } },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a loopback port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await launch({ profileRoot: scratch, extra: ['--no-sandbox'] });
  page = await newPage(browser);
}, 120_000);

afterAll(async () => { await browser?.close(); await server?.close(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

const LIST = '[data-testid="chronology-list"]', PANE = '[data-testid="chronology-document-pane"]';
const js = (v: unknown) => JSON.stringify(v);
async function open(width: number, height: number, mobile = false) {
  await page.s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await page.navigate(`${origin}/chronology`);
  await page.waitFor(`document.querySelector('main#main ${LIST}')`);
}
const shownRefs = () => page.evaluate(`[...document.querySelectorAll('${LIST} .grid-row[data-ref]')].slice(0, 20).map((r) => r.dataset.ref)`) as Promise<string[]>;
const ready = () => page.evaluate(`document.querySelector('main#main').dataset.ready ?? null`) as Promise<string | null>;
const settled = () => page.waitFor(`document.querySelector('main[data-ready="chronology"]') && document.querySelector('${LIST} .grid-table[data-complete="true"]')`);
async function press(selector: string) {
  const box = await page.evaluate(`(() => { const e = document.querySelector(${js(selector)}); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.s('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
  await page.s('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
}
const preview = (r: string) => press(`${LIST} .grid-row[data-ref="${r}"] button.preview`);
// Horizontal overlap, in px, between each heading's text and the next heading's (J3's phone-headings measure).
const headingOverlaps = () => page.evaluate(`(() => {
  const ext = (h) => { const r = document.createRange(); r.selectNodeContents(h); const b = [...r.getClientRects()].filter((x) => x.width > 0); return b.length ? [Math.min(...b.map((x) => x.left)), Math.max(...b.map((x) => x.right))] : null; };
  const xs = [...document.querySelectorAll('${LIST} .grid-head [role="columnheader"]')].map(ext).filter(Boolean);
  return xs.slice(1).map((x, i) => Math.round(xs[i][1] - x[0])).filter((o) => o > 0.5);
})()`) as Promise<number[]>;
const paneRef = () => page.evaluate(`document.querySelector('${PANE}').dataset.ref ?? null`) as Promise<string | null>;
const focusedLabel = () => page.evaluate(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`) as Promise<string>;
const docParam = () => page.evaluate(`new URLSearchParams(location.search).get('doc')`) as Promise<string | null>;
const box = (selector: string) => page.evaluate(`(() => { const e = document.querySelector(${js(selector)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })()`);
// The final order by the default sort, worked out here from the data: date ascending, the undated rows first, ties in
// package order.
const FINAL = [...rows.slice(DATED), ...rows.slice(0, DATED)].map((r) => r.ref);

test('the list never shows an order that the whole list then changes; it is ready only once its order is final', async () => {
  await open(1280, 800);
  // Longer than the 1.2 s the whole list took on staging, so rows held back by a timer would show here.
  await page.evaluate('new Promise((r) => setTimeout(r, 1500))');
  const before = { refs: await shownRefs(), ready: await ready() };
  await page.evaluate('window.__releaseList()');
  await settled();
  const after = await shownRefs();
  expect(after).toEqual(FINAL.slice(0, 20));
  expect(after.slice(0, before.refs.length), 'rows shown before the whole list arrived are its head').toEqual(before.refs);
  if (before.ready) expect(before.refs, 'a ready page shows the final order').toEqual(after);
}, 60_000);

test('at 1280 px a preview keeps its row in view, the headings sit over their cells and the Original column scrolls into reach', async () => {
  const target = FINAL[8]!;
  await preview(target);
  await page.waitFor(`document.querySelector('${PANE}[data-ref="${target}"]')`);
  const list = await box(`${LIST} .table-scroll`), row = await box(`${LIST} .grid-row[data-ref="${target}"]`);
  expect(row.top >= list.top - 1 && row.bottom <= list.bottom + 1, `row ${target} stays inside the list (${js(row)} in ${js(list)})`).toBe(true);
  const lefts = await page.evaluate(`(() => {
    const xs = (r) => [...r.children].map((c) => Math.round(c.getBoundingClientRect().left));
    return { head: xs(document.querySelector('${LIST} .grid-head')), body: xs(document.querySelector('${LIST} .grid-row[data-ref="${target}"]')) };
  })()`);
  expect(lefts.body, 'each heading starts where its column starts').toEqual(lefts.head);
  expect(await headingOverlaps(), 'no heading runs into the next').toEqual([]);
  const reach = await page.evaluate(`(() => {
    const s = document.querySelector('${LIST} .table-scroll'); s.scrollLeft = s.scrollWidth;
    const view = s.getBoundingClientRect(), row = document.querySelector('${LIST} .grid-row[data-ref="${target}"]');
    const last = row.lastElementChild.getBoundingClientRect(), head = document.querySelector('${LIST} .grid-head').lastElementChild.getBoundingClientRect();
    return { view: [view.left, view.right], last: [last.left, last.right], head: [head.left, head.right], row: row.getBoundingClientRect().right };
  })()`);
  expect(reach.last[0] >= reach.view[0] && reach.last[1] <= reach.view[1] + 1, `the Original cell scrolls fully into the list (${js(reach)})`).toBe(true);
  expect(reach.head[1] <= reach.view[1] + 1, 'and so does its heading').toBe(true);
  expect(reach.row >= reach.last[1], 'the selected row reaches its Original cell').toBe(true);
  await page.evaluate(`document.querySelector('${LIST} .table-scroll').scrollLeft = 0`);
}, 60_000);

test('at 1280 px Close and Escape clear the selection, give the list the full width and return focus to the row', async () => {
  const first = FINAL[8]!;
  const close = await box(`${PANE} .pane-back button`);
  expect(close && close.width > 0 && close.height > 0, 'the pane shows a close control').toBe(true);
  await press(`${PANE} .pane-back button`);
  await page.waitFor(`!document.querySelector('${PANE}').dataset.ref`);
  expect(await box(PANE), 'the pane is gone').toBeNull();
  expect((await box(LIST)).width).toBeCloseTo((await box('.chrono-split')).width, 0);
  expect(await docParam()).toBeNull();
  expect(await focusedLabel()).toBe(`Preview ${first}`);
  expect(await page.evaluate(`document.activeElement.getAttribute('aria-pressed')`)).toBe('false');

  const second = FINAL[3]!;
  await preview(second);
  await page.waitFor(`document.querySelector('${PANE}[data-ref="${second}"]')`);
  expect(await docParam()).toBe(second);
  await page.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`!document.querySelector('${PANE}').dataset.ref`);
  expect(await docParam()).toBeNull();
  expect(await focusedLabel()).toBe(`Preview ${second}`);
}, 60_000);

test('at 390 px the document opens below the list and Back to list returns to its row', async () => {
  await open(390, 844, true);
  await page.evaluate('window.__releaseList()');
  await settled();
  const target = FINAL[2]!;
  await preview(target);
  await page.waitFor(`document.querySelector('${PANE}[data-ref="${target}"]')`);
  const list = await box(LIST), pane = await box(PANE), back = await box(`${PANE} .pane-back button`);
  expect(pane.top >= list.bottom - 1, 'the pane sits below the list').toBe(true);
  expect(back.width >= 44 && back.height >= 44, 'Back is a 44 px target').toBe(true);
  expect(await page.evaluate(`document.querySelector('${PANE} .pane-back button').innerText.trim()`)).toBe('Back to list');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await headingOverlaps(), 'no heading runs into the next').toEqual([]);
  await press(`${PANE} .pane-back button`);
  await page.waitFor(`!document.querySelector('${PANE}').dataset.ref`);
  expect(await docParam()).toBeNull();
  expect(await focusedLabel()).toBe(`Preview ${target}`);
}, 60_000);
