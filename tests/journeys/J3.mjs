import { run, direct, check } from './lib.mjs';
// Ticket 11's acceptance: one click on a row shows its original in the pane beside the list; one click on a citation opens the
// matching document page. The row step and the citation step are separate, so neither stands in for the other.
// GRS-271: the pane must show the row's original, not a failure state (every hosted pane once said the original was gone),
// and the same holds at a 390 px phone with touch, where the pane sits under the list and the headings must not overlap.
// Where a pane ends. A hosted PDF ends only in its viewer's rendered page or its viewer's error state, canvas or not; an
// image once it has decoded; an email, a download-only file and the local pane's links are their own end.
const PDF = '[data-viewer="pdf"]';
const PDF_RENDERED = `${PDF}[data-viewer-state="ready"] canvas[data-testid="pdf-page"][data-rendered="true"]`;
const PDF_FAILED = `${PDF}[data-viewer-state="error"]`;
const OTHER = 'img.pane-image, [data-pane-state="local-original"], [data-pane-state="download-only"], [data-pane-state="email"]';
const FAILED = '[data-pane-state="missing"], [data-pane-state="error"], [data-pane-state="not-found"]';
const rowWithOriginal = (page, list) => list.locator('[data-ref]').filter({ has: page.locator('button.preview') }).filter({ has: page.locator('[data-file="present"]') });
/** Resolves to what the pane shows (`pdf`, `image` or the pane state), or throws when it shows a failure. */
async function paneShowsOriginal(pane) {
  await pane.locator(`${FAILED}, ${PDF}, ${OTHER}`).first().waitFor();
  const failed = pane.locator(FAILED);
  check(!(await failed.count()), `Pane shows "${await failed.first().getAttribute('data-pane-state').catch(() => '?')}" for a row whose original the list marks present`);
  if (await pane.locator(PDF).count()) {
    await pane.locator(`${PDF_RENDERED}, ${PDF_FAILED}`).first().waitFor();
    check(!(await pane.locator(PDF_FAILED).count()), "The pane's PDF viewer could not render the original");
    return 'pdf';
  }
  const image = pane.locator('img.pane-image');
  if (await image.count()) {
    check(await image.evaluate(i => i.decode().then(() => i.naturalWidth > 0, () => false)), "The pane's image did not load");
    return 'image';
  }
  return pane.locator(OTHER).first().getAttribute('data-pane-state');
}
/** Horizontal overlap, in px, between each heading's text and the next heading's. */
const headingOverlaps = page => page.locator('[data-testid="chronology-list"] .grid-head [role="columnheader"]').evaluateAll(hs => {
  const ext = h => { const r = document.createRange(); r.selectNodeContents(h); const b = [...r.getClientRects()].filter(x => x.width > 0); return b.length ? [Math.min(...b.map(x => x.left)), Math.max(...b.map(x => x.right))] : null; };
  const xs = hs.map(ext).filter(Boolean);
  return xs.slice(1).map((x, i) => Math.round(xs[i][1] - x[0])).filter(o => o > 0.5);
});
export const journey = () => run('J3', async j => {
  await j.go('chronology', 'chronology');
  const list = j.page.locator('[data-testid="chronology-list"]'); await list.waitFor();
  const row = rowWithOriginal(j.page, list).first(); await row.waitFor();
  const ref = await row.getAttribute('data-ref');
  const pane = j.page.locator(`[data-testid="chronology-document-pane"][data-ref="${ref}"]`);
  await j.measure('one-click-row', () => row.locator('button.preview').click(), () => pane.waitFor());
  await j.attempt('split-pane', async () => {
    check(await list.isVisible() && await pane.isVisible(), 'Chronology list and backing document are not simultaneously visible; split pane missing');
    const a = await list.boundingBox(), b = await pane.boundingBox();
    check(a.width > 0 && b.width > 0 && (a.x + a.width <= b.x + 2 || b.x + b.width <= a.x + 2), 'Split panes must be side by side');
    check((await pane.innerText()).trim().length > 0 || await pane.locator('iframe,canvas').count() > 0, 'Backing document pane empty');
    j.results.push({ name: 'split-pane', status: 'PASS' });
  });
  await j.attempt('pane-original', async () => { j.metadata.paneShows = await paneShowsOriginal(pane); j.results.push({ name: 'pane-original', status: 'PASS' }); });
  const cite = list.locator('a[href*="/doc/"]').first(); await cite.waitFor();
  const citeRef = decodeURIComponent((await cite.getAttribute('href')).split('/').pop());
  await j.measure('one-click-citation', () => cite.click(), () => j.page.locator(`main[data-ready="doc:${citeRef}"]`).waitFor());
  j.metadata.citationClicks = 1;
  // The phone: a 390 px touch context with the same session; three rows, each tapped from its list position.
  const phone = await j.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState: await j.context.storageState() });
  try {
    const p = await phone.newPage(); p.setDefaultTimeout(10000);
    await p.goto(j.url('chronology'), { waitUntil: 'domcontentloaded' }); await p.locator('main[data-ready="chronology"]').waitFor();
    const plist = p.locator('[data-testid="chronology-list"]');
    await j.attempt('phone-headings', async () => {
      const overlaps = await headingOverlaps(p);
      check(!overlaps.length, `Chronology headings overlap at 390 px by ${overlaps.join(', ')} px`);
      j.results.push({ name: 'phone-headings', status: 'PASS' });
    });
    await j.attempt('phone-pane-original', async () => {
      const rows = rowWithOriginal(p, plist); await rows.first().waitFor();
      const n = Math.min(3, await rows.count()), shows = [];
      for (let i = 0; i < n; i++) {
        if (i) await p.locator('[data-testid="chronology-document-pane"] .pane-back').tap();
        const r = rows.nth(i), rref = await r.getAttribute('data-ref');
        const button = r.locator('button.preview'); await button.scrollIntoViewIfNeeded(); await button.tap();
        shows.push(await paneShowsOriginal(p.locator(`[data-testid="chronology-document-pane"][data-ref="${rref}"]`)));
      }
      j.metadata.phonePaneShows = shows;
      j.results.push({ name: 'phone-pane-original', status: 'PASS' });
    });
  } finally { await phone.close(); }
});
if (direct(import.meta.url)) await journey();
