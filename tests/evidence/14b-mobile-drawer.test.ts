// Real Chromium and client-compiled AppShell + the nine real hosted wrappers/local pages.
// Synthetic props and inert Kit navigation/form hooks isolate the component boundary; this is not hosted acceptance.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
// @ts-expect-error the repository's CDP driver is JavaScript without declarations.
import { launch, newPage } from '../e2e/pilot/lib/cdp.mjs';

const routes = ['quantum/payments_tab', 'quantum/interest_calc_tab', 'evidence/filings_tab', 'quantum/settlement_tab',
  'litigation/enforcement_tab', 'litigation/crossexam_tab', 'litigation/authorities_tab', 'litigation/heads_tab', 'analysis/info_required_tab'];
const file = { name: 'synthetic.csv', note: null };
const props = [
  { subtitle: null, claim: '1000', claimDate: '2200-01-01', recon: [], known: [], payments: [], exportName: file },
  { defaults: { rate: 10, from: '2200-01-01', to: '2200-01-02' }, headlineDue: '1000', headlineDate: '2200-01-02', paymentDates: [], note: null, known: [] },
  { groups: [], files: [], entries: [], editing: null, content: { subtitle: null, orientation: null, registerIntro: null }, exportNames: { filings: file, register: file } },
  { subtitle: null, narrative: null, defaults: { probability: 50, years: 1, discount: 5, cost: 0 }, claim: '1000', payments: { count: 0, counted: 0, gross: '100000', paid: '0', excess: null, claimDate: '2200-01-01' } },
  { present: true, rows: [], phases: [], content: { subtitle: null, why: null }, known: [] },
  { rows: [], tip: null, known: [], addId: 'synthetic-add' },
  { present: true, imported: [], user: [], known: [], addId: 'synthetic-add', exportName: file },
  { rows: [], caption: null, exportName: file, addId: 'synthetic-add' },
  { heading: 'Information Required', rows: [{ key: 'synthetic-item', item: 'Synthetic request', owner: '', status: '', done: false }], detached: 0 },
];
let scratch: string, server: ViteDevServer, browser: any, page: any;

beforeAll(async () => {
  const root = process.cwd();
  await mkdir(path.join(root, '.local'), { recursive: true });
  scratch = await mkdtemp(path.join(root, '.local/14b-drawer-'));
  const version = { id: `sha256:${'a'.repeat(64)}`, titleName: 'Synthetic matter' };
  const data = props.map((p) => ({ ...p, version, base: '/cases/synthetic/v', empty: false }));
  const shell = { brand: 'ClearCase', caseName: 'Synthetic matter', base: '/cases/synthetic/v', resultsVersion: version.id,
    current: 'payments_tab', published: { label: 'Published', at: null, documents: 1 }, searchHref: '/search', account: null, actions: [] };
  await writeFile(path.join(scratch, 'Harness.svelte'), `<script>
    import AppShell from '${root}/src/lib/components/AppShell.svelte';
    import '${root}/src/app.css';
    ${routes.map((r, i) => `import P${i} from '${root}/deploy/client/routes/cases/[caseId]/v/[version]/${r}/+page.svelte';`).join('\n')}
    const pages = [${routes.map((_, i) => `P${i}`).join(',')}], data = ${JSON.stringify(data)};
    const shell = ${JSON.stringify(shell)};
    let index = $state(0);
    const Page = $derived(pages[index]);
  </script>
  <AppShell {shell}>
    {#snippet sidebar()}<nav class="views" aria-label="Case views">{#each pages as _, i}<a id={'view-'+i} href={'#view-'+i} aria-current={i === index ? 'page' : undefined} onclick={() => index = i}>View {i}</a>{/each}</nav>{/snippet}
    {#key index}<Page data={data[index]} />{/key}
  </AppShell>`);
  await writeFile(path.join(scratch, 'main.js'), "import { mount } from 'svelte'; import App from './Harness.svelte'; mount(App, {target: document.body});");
  await writeFile(path.join(scratch, 'kit.js'), "export const page = {url: new URL('http://127.0.0.1/')}; export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const goto = async () => {}; export const invalidateAll = async () => {}; export const applyAction = async () => {}; export const enhance = () => ({destroy(){}});");
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script type="module" src="/@fs/${scratch}/main.js"></script></body></html>`;
  server = await createServer({ configFile: false, root, logLevel: 'error',
    plugins: [svelte({ configFile: false }), { name: '14b-mobile-entry', configureServer(s) {
      s.middlewares.use('/14b-mobile', (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
    } }],
    resolve: { alias: { $lib: path.join(root, 'src/lib'), $local: path.join(root, 'src/routes/v/[vid]'),
      '$app/forms': path.join(scratch, 'kit.js'), '$app/navigation': path.join(scratch, 'kit.js'), '$app/state': path.join(scratch, 'kit.js') } },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  // The shared repository CDP driver restricts non-loopback DNS and owns this browser's PID/temporary profile.
  browser = await launch({ profileRoot: scratch, extra: ['--no-sandbox'] });
  page = await newPage(browser);
  await page.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a loopback port');
  await page.navigate(`http://127.0.0.1:${address.port}/14b-mobile`);
  await page.waitFor('document.querySelector("main[data-ready=payments_tab]") && document.querySelector("#nav-toggle")');
}, 120_000);

afterAll(async () => { await browser?.close(); await server?.close(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function click(selector: string) {
  const box = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView(); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await page.s('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
  await page.s('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
}

test('14b mobile drawer excludes every wrapped page from focus/accessibility and restores navigation readiness', async () => {
  expect(await page.evaluate('window.innerWidth')).toBe(390);
  for (const [i, route] of routes.entries()) {
    const id = route.split('/')[1]!;
    await page.waitFor(`document.querySelector('main[data-ready="${id}"]') && !document.querySelector('.case-shell.nav-open')`);
    // Use a real enabled control; an empty enforcement register falls back to its programmatically focusable heading.
    await page.evaluate(`(() => { const control = document.querySelector('main input:not([disabled]):not([type=hidden]), main button:not([disabled]), main select:not([disabled]), main textarea:not([disabled])') ?? document.querySelector('main [data-page-heading]'); control.setAttribute('data-mobile-focus-target', ''); control.focus(); })()`);
    expect(await page.evaluate('!!document.activeElement.closest("main")')).toBe(true);
    await click('#nav-toggle');
    await page.waitFor('document.querySelector(".case-shell.nav-open") && document.querySelector(".side").contains(document.activeElement)');
    expect(await page.evaluate('document.querySelector("[data-testid=analysis-content]").inert')).toBe(true);
    await page.evaluate('document.querySelector("[data-mobile-focus-target]").focus()');
    expect(await page.evaluate('document.querySelector(".side").contains(document.activeElement)')).toBe(true);
    const { root } = await page.s('DOM.getDocument');
    const { nodeId } = await page.s('DOM.querySelector', { nodeId: root.nodeId, selector: 'main [data-page-heading]' });
    const ax = await page.s('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    expect(ax.nodes[0].ignored).toBe(true);
    await page.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor('!document.querySelector(".case-shell.nav-open") && document.activeElement.id === "nav-toggle"');
    expect(await page.evaluate('document.querySelector("[data-testid=analysis-content]").inert')).toBe(false);
    await page.evaluate('document.querySelector("[data-mobile-focus-target]").focus()');
    expect(await page.evaluate('document.activeElement.hasAttribute("data-mobile-focus-target")')).toBe(true);
    if (i + 1 < routes.length) { await click('#nav-toggle'); await click(`#view-${i + 1}`); }
  }
}, 120_000);
