import { run, direct, check, paint, drawn, MODE, PAGE_MS, PDF_MS, PDF, PDF_RENDERED, PDF_FAILED } from './lib.mjs';
// Ticket 11's acceptance: one click on a row shows its original in the pane beside the list; one click on a citation opens the
// matching document page. The row step and the citation step are separate, so neither stands in for the other.
// GRS-271: the pane must show the row's original, not a failure state (every hosted pane once said the original was gone),
// and the same holds at a 390 px phone with touch, where the pane sits under the list and the headings must not overlap.
// Where a pane ends. A hosted PDF ends only in its viewer's rendered page or its viewer's error state, canvas or not; an
// image once it has decoded; an email, a download-only file and the local pane's links are their own end, each only with
// the visible links that reach that original (GRS-266).
const OTHER = 'img.pane-image, [data-pane-state="local-original"], [data-pane-state="download-only"], [data-pane-state="email"]';
const FAILED = '[data-pane-state="missing"], [data-pane-state="error"], [data-pane-state="not-found"]';
// The chronology's column headings (src/routes/v/[vid]/chronology/+page.svelte); Date basis is shown only where the source has it.
const HEADINGS = ['Date', 'Ref', 'Title / subject', 'Type', 'Bundle', 'Amount', 'Status', 'Original'];
const PHONE_ROWS = 3;
// GRS-273: a viewer whose image decoders fail draws a scan's page 1 blank under its rendered flags, but an original's page 1 may be
// legitimately blank too. A pane whose page 1 holds no ink is a `blank-page`; while every PDF sampled is one, up to BLANK_TRIES more
// candidate rows are opened, and the step fails only when none of the sampled PDFs draws ink.
const BLANK_TRIES = 4;
const PAGE_1 = `${PDF_RENDERED}[data-page-number="1"]`;
const rowWithOriginal = (page, list) => list.locator('[data-ref]').filter({ has: page.locator('button.preview') }).filter({ has: page.locator('[data-file="present"]') });
/** The pane's visible links, each with its role and its href resolved against the page. */
const paneLinks = pane => pane.locator('a[href]').evaluateAll(as => as.filter(a => a.getClientRects().length > 0 && getComputedStyle(a).visibility !== 'hidden')
  .map(a => ({ action: a.dataset.action || '', state: a.closest('[data-pane-state]')?.dataset.paneState || '', url: a.href })));
/** The hosted original an href reaches (`/cases/<case>/originals/<asset>`, then `/view` or `?download=1`), or null. */
const originalOf = (url, ending) => {
  const u = new URL(url), m = u.pathname.match(/^\/cases\/([^/]+)\/originals\/([^/]+?)(\/view)?$/);
  if (!m || u.origin !== new URL(process.env.BASE_URL).origin || decodeURIComponent(m[1]) !== process.env.CASE_ID) return null;
  return (ending === 'view' ? m[3] && !u.search : !m[3] && u.searchParams.get('download') === '1') ? m[2] : null;
};
/** Checks that a pane state offering its original by link shows the visible links that reach this row's original. */
async function checkOriginalLinks(pane, state, ref) {
  const links = await paneLinks(pane);
  if (MODE !== 'hosted') {
    check(links.some(l => l.action === 'open-document' && new URL(l.url).pathname.endsWith(`/doc/${encodeURIComponent(ref)}`)), `The pane's ${state} state has no visible link to its document page`);
    return;
  }
  const viewer = links.find(l => l.action === 'open-viewer' && originalOf(l.url, 'view'));
  check(viewer, `The pane's ${state} state has no visible link to its original's viewer`);
  const asset = originalOf(viewer.url, 'view');
  check(links.some(l => l.state === state && l.action === 'download-original' && originalOf(l.url, 'download') === asset), `The pane's ${state} state has no visible download link to the same original`);
  if (state === 'email') check(links.some(l => l.state === state && originalOf(l.url, 'view') === asset), "The pane's email state has no visible link to open it");
}
/** Resolves to what the pane shows (`pdf`, `image` or the pane state), or throws when it shows a failure. */
async function paneShowsOriginal(pane, ref) {
  await pane.locator(`${FAILED}, ${PDF}, ${OTHER}`).first().waitFor();
  const failed = pane.locator(FAILED);
  if (await failed.count()) throw new Error(`Pane shows "${await failed.first().getAttribute('data-pane-state')}" for a row whose original the list marks present`);
  if (await pane.locator(PDF).count()) {
    await pane.locator(`${PDF_RENDERED}, ${PDF_FAILED}`).first().waitFor();
    check(!(await pane.locator(PDF_FAILED).count()), "The pane's PDF viewer could not render the original");
    check(await pane.locator(PAGE_1).evaluate(c => c.getClientRects().length > 0 && c.width > 0 && c.height > 0), "The pane's first PDF page is not visible");
    return 'pdf';
  }
  const image = pane.locator('img.pane-image');
  if (await image.count()) {
    check(await image.evaluate(i => i.decode().then(() => i.naturalWidth > 0, () => false)), "The pane's image did not load");
    return 'image';
  }
  const state = await pane.locator(OTHER).first().getAttribute('data-pane-state');
  await checkOriginalLinks(pane, state, ref);
  return state;
}
/** What a pane that `shows` an original shows once its ink is counted: `blank-page` for a PDF whose page 1 holds none. */
const inkOf = async (pane, shows) => shows === 'pdf' && !(await drawn(pane.locator(PAGE_1))) ? 'blank-page' : shows;
/**
 * While every PDF in `shown` is a blank page, opens the next candidate rows (`open(i)` shows row i of `rows` and resolves to what its
 * pane shows, ink counted), up to BLANK_TRIES more. Fails when the sampled PDFs still draw no ink; resolves to the extra samples.
 */
async function sampleForInk(shown, rows, open) {
  const all = [...shown], last = Math.min(await rows.count(), shown.length + BLANK_TRIES);
  while (all.includes('blank-page') && !all.includes('pdf') && all.length < last) all.push(await open(all.length));
  check(!all.includes('blank-page') || all.includes('pdf'), `No sampled chronology PDF drew ink on page 1 (${all.join(', ')}): a blank page, or a viewer that drew nothing`);
  return all.slice(shown.length);
}
const HEAD = '[data-testid="chronology-list"] .grid-head [role="columnheader"]';
/** Each column heading whose text is on screen, without its sort mark. */
const headingTexts = page => page.locator(HEAD).evaluateAll(hs => hs.filter(h => {
  const r = document.createRange(); r.selectNodeContents(h);
  return [...r.getClientRects()].some(x => x.width > 0 && x.height > 0) && getComputedStyle(h).visibility !== 'hidden';
}).map(h => h.textContent.replace(/[▲▼]/g, '').trim()));
/** Horizontal overlap, in px, between each heading's text and the next heading's. */
const headingOverlaps = page => page.locator(HEAD).evaluateAll(hs => {
  const ext = h => { const r = document.createRange(); r.selectNodeContents(h); const b = [...r.getClientRects()].filter(x => x.width > 0); return b.length ? [Math.min(...b.map(x => x.left)), Math.max(...b.map(x => x.right))] : null; };
  const xs = hs.map(ext).filter(Boolean);
  return xs.slice(1).map((x, i) => Math.round(xs[i][1] - x[0])).filter(o => o > 0.5);
});
export const journey = () => run('J3', async j => {
  await j.go('chronology', 'chronology');
  const list = j.page.locator('[data-testid="chronology-list"]'); await list.waitFor();
  const candidates = rowWithOriginal(j.page, list), row = candidates.first(); await row.waitFor();
  const ref = await row.getAttribute('data-ref');
  const pane = j.page.locator(`[data-testid="chronology-document-pane"][data-ref="${ref}"]`);
  // One click, timed twice: to the pane beside the list (an action), and on to the original drawn in it (a first PDF page,
  // or an action for an image or a linked state).
  let clicked, paneError;
  await j.measure('one-click-row', () => { clicked = performance.now(); return row.locator('button.preview').click(); }, () => pane.waitFor());
  try {
    const shows = await paneShowsOriginal(pane, ref); await paint(j.page);
    j.timed('one-click-row-original', clicked, shows === 'pdf' ? PDF_MS : PAGE_MS);
    j.metadata.paneShows = await inkOf(pane, shows);
  } catch (error) { paneError = error; j.timed('one-click-row-original', clicked, PDF_MS, error); }
  await j.attempt('split-pane', async () => {
    check(await list.isVisible() && await pane.isVisible(), 'Chronology list and backing document are not simultaneously visible; split pane missing');
    const a = await list.boundingBox(), b = await pane.boundingBox();
    check(a.width > 0 && b.width > 0 && (a.x + a.width <= b.x + 2 || b.x + b.width <= a.x + 2), 'Split panes must be side by side');
    check((await pane.innerText()).trim().length > 0 || await pane.locator('iframe,canvas').count() > 0, 'Backing document pane empty');
    j.results.push({ name: 'split-pane', status: 'PASS' });
  });
  await j.attempt('pane-original', async () => {
    if (paneError) throw paneError;
    const extra = await sampleForInk([j.metadata.paneShows], candidates, async i => {
      const r = candidates.nth(i), rref = await r.getAttribute('data-ref');
      await r.locator('button.preview').click();
      const p = j.page.locator(`[data-testid="chronology-document-pane"][data-ref="${rref}"]`);
      return inkOf(p, await paneShowsOriginal(p, rref));
    });
    if (extra.length) j.metadata.paneSamples = [j.metadata.paneShows, ...extra];
    j.results.push({ name: 'pane-original', status: 'PASS' });
  });
  const cite = list.locator('a[href*="/doc/"]').first(); await cite.waitFor();
  const citeRef = decodeURIComponent((await cite.getAttribute('href')).split('/').pop());
  await j.measure('one-click-citation', () => cite.click(), () => j.page.locator(`main[data-ready="doc:${citeRef}"]`).waitFor());
  j.metadata.citationClicks = 1;
  // The phone: a 390 px touch context with the same session; three rows, each tapped from its list position. Its network and
  // page errors count like the desktop's.
  const phone = await j.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState: await j.context.storageState() });
  try {
    const p = await phone.newPage(); p.setDefaultTimeout(10000);
    await p.goto(j.url('chronology'), { waitUntil: 'domcontentloaded' }); await p.locator('main[data-ready="chronology"]').waitFor();
    const plist = p.locator('[data-testid="chronology-list"]');
    await j.attempt('phone-headings', async () => {
      const shown = await headingTexts(p);
      const missing = HEADINGS.filter(h => !shown.includes(h));
      check(!missing.length, `Chronology headings not visible at 390 px: ${missing.join(', ') || 'none'}`);
      const overlaps = await headingOverlaps(p);
      check(!overlaps.length, `Chronology headings overlap at 390 px by ${overlaps.join(', ')} px`);
      j.results.push({ name: 'phone-headings', status: 'PASS' });
    });
    await j.attempt('phone-pane-original', async () => {
      const rows = rowWithOriginal(p, plist); await rows.first().waitFor();
      const count = await rows.count();
      check(count >= PHONE_ROWS, `Only ${count} chronology rows with an original at 390 px; the phone check taps ${PHONE_ROWS}`);
      // Each tap is timed through the original drawn in the pane, against one-click-row-original's budgets.
      const taps = [];
      for (let i = 0; i < PHONE_ROWS; i++) {
        if (i) await p.locator('[data-testid="chronology-document-pane"] .pane-back').tap();
        const r = rows.nth(i), rref = await r.getAttribute('data-ref');
        const button = r.locator('button.preview'); await button.scrollIntoViewIfNeeded();
        const start = performance.now(); await button.tap();
        const ppane = p.locator(`[data-testid="chronology-document-pane"][data-ref="${rref}"]`);
        const shows = await paneShowsOriginal(ppane, rref); await paint(p);
        const ms = Math.round(performance.now() - start);
        taps.push({ shows: await inkOf(ppane, shows), ms, budgetMs: shows === 'pdf' ? PDF_MS : PAGE_MS });
      }
      j.metadata.phonePaneShows = taps.map(t => t.shows);
      const extra = await sampleForInk(j.metadata.phonePaneShows, rows, async i => {
        await p.locator('[data-testid="chronology-document-pane"] .pane-back').tap();
        const r = rows.nth(i), rref = await r.getAttribute('data-ref'), button = r.locator('button.preview');
        await button.scrollIntoViewIfNeeded(); await button.tap();
        const ppane = p.locator(`[data-testid="chronology-document-pane"][data-ref="${rref}"]`);
        return inkOf(ppane, await paneShowsOriginal(ppane, rref));
      });
      if (extra.length) j.metadata.phonePaneSamples = [...j.metadata.phonePaneShows, ...extra];
      const over = taps.filter(t => t.ms >= t.budgetMs);
      j.results.push({ name: 'phone-pane-original', status: over.length ? 'FAIL' : 'PASS', taps, ...(over.length ? { reason: 'Latency budget exceeded' } : {}) });
    });
  } finally { await phone.close(); }
});
if (direct(import.meta.url)) await journey();
