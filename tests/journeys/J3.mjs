import { run, direct, check } from './lib.mjs';
// Ticket 11's acceptance: one click on a row shows its original in the pane beside the list; one click on a citation opens the
// matching document page. The row step and the citation step are separate, so neither stands in for the other.
export const journey = () => run('J3', async j => {
  await j.go('chronology', 'chronology');
  const list = j.page.locator('[data-testid="chronology-list"]'); await list.waitFor();
  const row = list.locator('[data-ref]').filter({ has: j.page.locator('button.preview') }).first(); await row.waitFor();
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
  const cite = list.locator('a[href*="/doc/"]').first(); await cite.waitFor();
  const citeRef = decodeURIComponent((await cite.getAttribute('href')).split('/').pop());
  await j.measure('one-click-citation', () => cite.click(), () => j.page.locator(`main[data-ready="doc:${citeRef}"]`).waitFor());
  j.metadata.citationClicks = 1;
});
if (direct(import.meta.url)) await journey();
