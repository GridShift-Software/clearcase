// Phone tap-target probe (GRS-272): the bounding box of every control the ticket lists, at 390x844 (mobile, touch) and at 1440x900,
// on a synthetic local build. Offline: loopback only, invented data, no sign-in to any real service.
//   measure: boots the local pilot (a synthetic case, imported through its own forms) and the hosted-gate server of --root, drives
//            Chromium over both, writes --out and prints a table. --require-green exits 1 unless every phone control is at least
//            44 px high and wide and the Documents list's first Open action is in view without scrolling sideways.
//            GRS-273: on the phone it also swipes the Documents table and the DOC-column analysis tables towards the row end and back,
//            and measures Open and the leading cell as seen: clipped by every ancestor and the viewport, and painted in a screenshot.
//   compare: two measure outputs (base, head): the phone table, and whether every 1440 box is identical.
// The probe reads the fixtures and server helpers of the checkout it is run from; --root is the build under test, so one probe
// measures the base and the head. Build first (--build) and run under the browser lock and the offline namespace:
//   browser-lock unshare -rn env OUTER_UID=$(id -u) OUTER_GID=$(id -g) tests/e2e/pilot/offline.sh \
//     bun tests/journeys/probes/phone-targets.mjs measure --root <worktree> --build --out <file> [--require-green] [--only local|hosted] [--shots DIR]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const MIN = 44;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PORTS = { app: 43560, originals: 43561, hosted: 43570 };

/** Every control the ticket lists, by view. `min` groups must reach 44 px both ways at the phone width. */
const GROUPS = {
  overview: { nav_toggle: '#nav-toggle', nav_links: '.side nav.views a', shortcut_links: 'ul.quick a' },
  chronology: { preview: 'button.preview', citation: '.chrono-grid [role="cell"] a.cite', sort_buttons: '.grid-head button', filters: '.filters input, .filters select', back_to_list: '.pane-back button' },
  documents: { open: '#documents-table td a.doc', bundle_buttons: '.toolbar [data-bundle]', filter: '#doc-filter', pager: '#documents-pager button' },
  document: { open_original: '#open-original' },
  signin: { sign_in_button: '#sign-in, #sign-in-link' },
  pdf_viewer: { page_zoom_controls: '[data-viewer="pdf"] button, [data-viewer="pdf"] input[type="number"]', download: '[data-viewer="pdf"] a[data-action="download-original"]' },
};

// GRS-273: the analysis views whose tables end in a DOC column of Open links.
const DOC_TABLES = ['evidence/contracts_tab', 'evidence/filings_tab', 'litigation/legality_tab', 'quantum/invoice_ledger_tab', 'quantum/quantum_tab', 'quantum/prescription_tab'];
const log = (...a) => console.error('[phone-targets]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(name);

async function boxes(page, selector) {
  return page.locator(selector).evaluateAll(els => els.map(e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' ? [r.x, r.y, r.width, r.height].map(n => Math.round(n * 10) / 10) : null;
  }).filter(Boolean));
}
/** One view's groups: the boxes found (capped), the smallest height and width, and the page's own scroll width. */
async function measure(page, groups) {
  const out = { scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth), groups: {} };
  for (const [name, selector] of Object.entries(groups)) {
    const found = await boxes(page, selector);
    out.groups[name] = { count: found.length, minH: found.length ? Math.min(...found.map(b => b[3])) : null, minW: found.length ? Math.min(...found.map(b => b[2])) : null, boxes: found.slice(0, 24) };
  }
  return out;
}
const ready = (page, id) => page.waitForSelector(`main[data-ready="${id}"]`, { timeout: 20000 });

/** In the page: the part of `e` on screen, clipped by every ancestor that clips its overflow and by the viewport (GRS-273: the
 *  DOM box of Open was whole while its card cut it off), and whether a tap at that part's centre reaches `e`. */
function seen(e) {
  const r = e.getBoundingClientRect(), round = n => Math.round(n * 10) / 10;
  let [l, t, right, b] = [r.left, r.top, r.right, r.bottom];
  for (let a = e.parentElement; a; a = a.parentElement) {
    const s = getComputedStyle(a), ar = a.getBoundingClientRect(), x = ar.left + a.clientLeft, y = ar.top + a.clientTop;
    if (s.overflowX !== 'visible') { l = Math.max(l, x); right = Math.min(right, x + a.clientWidth); }
    if (s.overflowY !== 'visible') { t = Math.max(t, y); b = Math.min(b, y + a.clientHeight); }
  }
  l = Math.max(l, 0); t = Math.max(t, 0); right = Math.min(right, innerWidth); b = Math.min(b, innerHeight);
  const w = Math.max(0, right - l), h = Math.max(0, b - t), at = w > 0 && h > 0 ? document.elementFromPoint(l + w / 2, t + h / 2) : null, hit = !!at && e.contains(at);
  return { x: round(l), y: round(t), w: round(w), h: round(h), boxX: round(r.x), boxW: round(r.width), boxH: round(r.height), hit, ...(hit || !at ? {} : { at: `${at.tagName.toLowerCase()}.${[...at.classList].join('.')}` }) };
}
/** Pixels in the screenshot of `box` (CSS px) darker than light grey: whether something is painted there, not only laid out. */
async function inkIn(page, box) {
  if (!(box.w >= 1 && box.h >= 1)) return 0;
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } }));
  const c = createCanvas(image.width, image.height), x = c.getContext('2d');
  x.drawImage(image, 0, 0);
  const d = x.getImageData(0, 0, image.width, image.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 160) ink++;
  return ink;
}
/** The first Open link and the first row's leading cell of `table`, as seen now, with the scroller's offset. */
async function openSeen(page, table) {
  // An expression rather than a function argument, so `seen` goes with it (the app's CSP refuses eval in the page).
  const out = await page.evaluate(`(() => { const seen = ${seen};
    const t = document.querySelector(${JSON.stringify(table)}), a = t?.querySelector('td a.doc'), lead = a?.closest('tr')?.querySelector('td');
    return a ? { scrollLeft: Math.round(t.closest('.table-scroll')?.scrollLeft ?? 0), open: seen(a), lead: seen(lead) } : null; })()`);
  if (out) out.open.ink = await inkIn(page, out.open);
  return out;
}
/** A finger swipe across `table`'s first row by `dx` CSS px (negative: towards the end of the row), then the scroll settles. */
async function swipe(page, table, dx) {
  const y = await page.evaluate(t => { const r = document.querySelector(t).querySelector('tbody tr').getBoundingClientRect(); return r.top + Math.min(r.height, 60) / 2; }, table);
  const session = await page.context().newCDPSession(page);
  const from = dx < 0 ? 300 : 90;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
  for (let i = 1; i <= 10; i++) { await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (dx * i) / 10, y }] }); await sleep(30); }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await sleep(800);
}
/** `table`'s Open link and leading cell at rest, after a swipe towards the row's end and after a swipe back (phone only). With
 *  --shots DIR, each state's screenshot is saved there as `<name>-<state>.png`. */
async function swipeCheck(page, table, name) {
  await page.evaluate(t => { const e = document.querySelector(t); window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 180); }, table);
  await sleep(300);
  const shots = arg('--shots'), shot = async state => { if (shots) await page.screenshot({ path: path.join(shots, `${name}-${state}.png`) }); };
  const states = { rest: await openSeen(page, table) };
  if (!states.rest) return null;
  await shot('rest');
  await swipe(page, table, -210); states.swiped = await openSeen(page, table); await shot('swiped');
  await swipe(page, table, 280); states.back = await openSeen(page, table); await shot('back');
  return states;
}

async function exec(cmd, args, { cwd, env = {}, label }) {
  log(label ?? `${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${label ?? cmd} exited ${r.status}: ${(r.stderr || r.stdout).split('\n').slice(-8).join(' | ')}`);
}

async function viewsLocal(browser, root, tmp) {
  const { buildCase } = await import(path.join(REPO, 'tests/e2e/pilot/lib/fixtures.ts'));
  const { startServer } = await import(path.join(REPO, 'tests/e2e/pilot/lib/server.mjs'));
  const { client } = await import(path.join(REPO, 'tests/e2e/pilot/lib/client.mjs'));
  const synth = await buildCase(path.join(tmp, 'case'), { caseId: 'phone-probe' });
  const server = await startServer({ root, port: PORTS.app, origPort: PORTS.originals, dataDir: path.join(tmp, 'data'), logFile: path.join(tmp, 'pilot.log') });
  try {
    const c = client(PORTS.app);
    const imported = await c.importPkg(synth.caseDir, synth.pkgDir);
    if (imported.importId === null) throw new Error(`import refused: ${imported.status} ${imported.text.slice(0, 200)}`);
    const activated = await c.activate(imported.importId);
    if (activated.error) throw new Error(`activation refused: ${activated.error}`);
    const rv = await c.activeVersion();
    if (!rv) throw new Error('no active version after activation');
    const base = `http://127.0.0.1:${PORTS.app}/v/${encodeURIComponent(rv)}`;
    const result = {};
    for (const [width, opts] of [['phone', PHONE], ['desktop', DESKTOP]]) {
      const context = await browser.newContext(opts);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const r = result[width] = {};
      const tap = loc => (width === 'phone' ? loc.tap() : loc.click());

      await page.goto(`${base}/overview`); await ready(page, 'overview');
      const toggle = page.locator('#nav-toggle');
      if (await toggle.isVisible()) { await tap(toggle); await page.waitForSelector('.case-shell.nav-open .side nav.views a'); }
      r.overview = await measure(page, GROUPS.overview);

      await page.goto(`${base}/chronology`); await ready(page, 'chronology');
      await page.waitForSelector('button.preview');
      await tap(page.locator('button.preview').first());
      await page.waitForSelector('[data-testid="chronology-document-pane"][data-ref]');
      r.chronology = await measure(page, GROUPS.chronology);

      await page.goto(`${base}/evidence/documents`); await ready(page, 'documents');
      await page.waitForSelector('#documents-table td a.doc');
      r.documents = await measure(page, GROUPS.documents);
      // The first Open action: is it inside the table's visible area now, with no sideways scroll?
      if (width === 'phone') r.documents.swipe = await swipeCheck(page, '#documents-table', 'documents');
      r.documents.firstOpen = await page.evaluate(() => {
        const a = document.querySelector('#documents-table td a.doc'), box = document.querySelector('.table-scroll');
        const l = a.getBoundingClientRect(), s = box.getBoundingClientRect();
        return { x: Math.round(l.x * 10) / 10, right: Math.round(l.right * 10) / 10, scrollerRight: Math.round(s.right * 10) / 10, inView: l.x >= s.x && l.right <= s.right + 0.5, tableScrolls: box.scrollWidth > box.clientWidth };
      });

      const refs = await page.locator('#documents-table tr[data-ref]').evaluateAll(rows => rows.map(r => r.getAttribute('data-ref')));
      for (const ref of refs.slice(0, 8)) {
        await page.goto(`${base}/doc/${encodeURIComponent(ref)}`); await ready(page, `doc:${ref}`);
        if (await page.locator('#open-original').count()) { r.document = await measure(page, GROUPS.document); r.document.ref = ref; break; }
      }
      if (!r.document) throw new Error('no synthetic document offers an original to open');
      if (width === 'phone') {
        result.docTables = {};
        for (const view of DOC_TABLES) {
          await page.goto(`${base}/${view}`); await ready(page, view.split('/')[1]);
          const tables = await page.locator('main table:has(td a.doc)').evaluateAll(ts => ts.map((t, i) => (t.dataset.probe = String(i), `table[data-probe="${i}"]`)));
          if (tables.length) result.docTables[view] = { scroll: await page.evaluate(t => { const s = document.querySelector(t).closest('.table-scroll'); return s ? { client: s.clientWidth, scroll: s.scrollWidth } : null; }, tables[0]), ...await swipeCheck(page, tables[0], view.split('/')[1]) };
        }
      }
      await context.close();
    }
    return result;
  } finally { log('local stop', JSON.stringify(await server.stop().catch(e => String(e)))); }
}

async function viewsHosted(browser, root) {
  const env = { PORT: String(PORTS.hosted), CI: '1', WRANGLER_SEND_METRICS: 'false' };
  const server = spawn('bun', ['run', '--bun', 'start:hosted'], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', d => (output += d)); server.stderr.on('data', d => (output += d));
  const up = `http://127.0.0.1:${PORTS.hosted}`;
  try {
    for (let i = 0; ; i++) {
      if (server.exitCode !== null) throw new Error(`start:hosted exited ${server.exitCode}: ${output.split('\n').slice(-6).join(' | ')}`);
      if (await fetch(`${up}/health`).then(r => r.ok, () => false)) break;
      if (i > 600) throw new Error('start:hosted did not answer /health in 60 s');
      await sleep(100);
    }
    const result = {};
    for (const [width, opts] of [['phone', PHONE], ['desktop', DESKTOP]]) {
      const context = await browser.newContext(opts);
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      const r = result[width] = {};
      await page.goto(`${up}/sign-in`);
      await page.waitForSelector('#test-identity');
      r.signin = await measure(page, GROUPS.signin);
      await page.locator('#test-identity').selectOption({ label: 'Client A viewer (case A1)' });
      await Promise.all([page.waitForURL(u => u.pathname !== '/sign-in'), page.locator('#sign-in').click()]);
      await page.goto(`${up}/cases/case-a1/originals/a1-letter/view`);
      await page.waitForSelector('[data-viewer="pdf"][data-viewer-state="ready"] canvas[data-rendered="true"]');
      r.pdf_viewer = await measure(page, GROUPS.pdf_viewer);
      await context.close();
    }
    return result;
  } finally {
    spawnSync('bun', ['run', '--bun', 'start:hosted', '--stop'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
    if (server.exitCode === null) server.kill('SIGTERM');
  }
}

const phoneTargets = out => {
  const rows = [];
  for (const side of Object.values(out.legs)) for (const [view, m] of Object.entries(side.phone ?? {})) for (const [name, g] of Object.entries(m.groups)) rows.push({ view, name, ...g });
  return rows;
};
const STATES = ['rest', 'swiped', 'back'];
const box = b => `${b.x}+${b.w}x${b.h} of ${b.boxX}+${b.boxW}x${b.boxH}`;
/** What the swipe check finds wrong with `states` of `name`. Documents (`pinned`): Open is seen whole, 44 x 44, painted and tappable in
 *  every state. Every table: the swipe moves it and the swipe back returns it, its leading cell is whole at rest and back, and its
 *  Open is seen whole and painted once the row is swiped to its end. */
const swipeFaults = (name, states, pinned) => {
  if (!states) return [`${name}: no Open link to measure`];
  const bad = [];
  const whole = b => b.w >= b.boxW - 0.5 && b.h >= b.boxH - 0.5;
  if (!(states.swiped.scrollLeft > 0)) bad.push(`${name}: the swipe did not scroll the table`);
  if (states.back.scrollLeft !== 0) bad.push(`${name}: the swipe back left the table at ${states.back.scrollLeft}`);
  for (const k of ['rest', 'back']) if (!whole(states[k].lead)) bad.push(`${name} ${k}: leading cell cut off, seen ${box(states[k].lead)}`);
  for (const k of pinned ? STATES : ['swiped']) {
    const o = states[k].open;
    if (!whole(o) || (pinned && (o.w < MIN || o.h < MIN))) bad.push(`${name} ${k}: Open seen ${box(o)}`);
    if (o.ink < 20) bad.push(`${name} ${k}: Open not painted (${o.ink} ink pixels)`);
    if (pinned && !o.hit) bad.push(`${name} ${k}: a tap on Open does not reach it`);
  }
  return bad;
};
const verdict = out => {
  const bad = phoneTargets(out).filter(g => g.count === 0 || g.minH < MIN || g.minW < MIN).map(g => `${g.view}.${g.name} ${g.count ? `${g.minW}x${g.minH}` : 'not found'}`);
  const open = out.legs.local?.phone?.documents?.firstOpen;
  if (open && !open.inView) bad.push(`documents.firstOpen x=${open.x} right=${open.right} (table edge ${open.scrollerRight}): not in view`);
  for (const [leg, side] of Object.entries(out.legs)) for (const [view, m] of Object.entries(side.phone ?? {})) if (m.scrollWidth > 390) bad.push(`${view} phone scrollWidth ${m.scrollWidth}`);
  const local = out.legs.local;
  if (local) {
    bad.push(...swipeFaults('documents', local.phone.documents.swipe, true));
    for (const [view, states] of Object.entries(local.docTables ?? {})) bad.push(...swipeFaults(view, states, false));
  }
  return bad;
};
const table = out => {
  const lines = ['view / control                      phone w x h (min)   count'];
  for (const g of phoneTargets(out)) lines.push(`${`${g.view}.${g.name}`.padEnd(36)}${(g.count ? `${g.minW} x ${g.minH}` : 'not found').padEnd(20)}${g.count}`);
  const open = out.legs.local?.phone?.documents?.firstOpen;
  if (open) lines.push(`documents first Open: x=${open.x}, right=${open.right}, table edge ${open.scrollerRight}, in view without scrolling: ${open.inView}`);
  for (const [leg, side] of Object.entries(out.legs)) for (const [view, m] of Object.entries(side.phone ?? {})) lines.push(`scrollWidth ${view} (phone): ${m.scrollWidth}`);
  const swiped = { documents: out.legs.local?.phone?.documents?.swipe, ...out.legs.local?.docTables };
  for (const [name, states] of Object.entries(swiped)) if (states) for (const k of STATES) {
    const { scrollLeft, open: o, lead } = states[k];
    lines.push(`${name.padEnd(26)} ${k.padEnd(6)} scroll ${String(scrollLeft).padStart(3)}  Open seen ${box(o)} ink ${o.ink} tap ${o.hit ? 'reaches it' : `lands on ${o.at ?? 'nothing'}`}  lead seen ${box(lead)}`);
  }
  return lines.join('\n');
};

async function runMeasure() {
  const root = path.resolve(arg('--root', REPO));
  const outFile = arg('--out');
  const only = arg('--only');
  if (flag('--build')) {
    if (only !== 'hosted') await exec('bun', ['run', '--bun', 'build'], { cwd: root, label: 'build (local pilot)' });
    if (only !== 'local') await exec('bun', ['run', '--bun', 'build:hosted'], { cwd: root, env: { CLEARCASE_HOSTED_PROFILE: 'hosted-gate' }, label: 'build:hosted (hosted-gate)' });
  }
  const pinned = path.join(os.homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
  const executablePath = process.env.CHROMIUM_PATH || (existsSync(pinned) ? pinned : undefined);
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-targets-'));
  const out = { revision: spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), chromium: browser.version(), legs: {} };
  try {
    if (only !== 'hosted') out.legs.local = await viewsLocal(browser, root, tmp);
    if (only !== 'local') out.legs.hosted = await viewsHosted(browser, root);
  } finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
  if (outFile) await fs.writeFile(outFile, JSON.stringify(out, null, 1));
  console.log(`revision ${out.revision}\n${table(out)}`);
  const bad = verdict(out);
  console.log(bad.length ? `RED: ${bad.length} below target\n  ${bad.join('\n  ')}` : 'GREEN: every listed control is at least 44 x 44, the first Open action is in view, and Open stays whole and painted through a swipe and back');
  process.exitCode = flag('--require-green') && bad.length ? 1 : 0;
}

async function runCompare() {
  const [a, b] = process.argv.slice(3).map(f => f);
  const [base, head] = await Promise.all([a, b].map(async f => JSON.parse(await fs.readFile(f, 'utf8'))));
  const cell = (o, leg, view, name) => o.legs[leg]?.phone?.[view]?.groups[name];
  console.log('control                             base w x h     head w x h');
  for (const g of phoneTargets(head)) {
    const leg = head.legs.local?.phone?.[g.view] ? 'local' : 'hosted';
    const was = cell(base, leg, g.view, g.name);
    const show = x => (x?.count ? `${x.minW} x ${x.minH}` : 'not found');
    console.log(`${`${g.view}.${g.name}`.padEnd(36)}${show(was).padEnd(15)}${show(g)}`);
  }
  const x = o => o.legs.local?.phone?.documents?.firstOpen;
  console.log(`documents first Open x: base ${x(base)?.x} (in view ${x(base)?.inView}), head ${x(head)?.x} (in view ${x(head)?.inView})`);
  const same = JSON.stringify(Object.fromEntries(Object.entries(base.legs).map(([k, v]) => [k, v.desktop]))) === JSON.stringify(Object.fromEntries(Object.entries(head.legs).map(([k, v]) => [k, v.desktop])));
  console.log(`1440x900 boxes (every listed control, every view) identical: ${same}`);
  process.exitCode = same ? 0 : 1;
}

const command = process.argv[2];
if (command === 'measure') await runMeasure();
else if (command === 'compare') await runCompare();
else { console.error('usage: phone-targets.mjs measure --root DIR [--build] [--out FILE] [--require-green] [--only local|hosted] | compare BASE.json HEAD.json'); process.exitCode = 2; }
