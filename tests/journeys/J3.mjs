import { run, direct, check } from './lib.mjs';
export const journey = () => run('J3', async j => {
  await j.go('chronology', 'chronology');
  const cite = j.page.locator('main a[href*="/doc/"]').first(); await cite.waitFor();
  const ref = decodeURIComponent((await cite.getAttribute('href')).split('/').pop());
  await j.measure('one-click-citation', () => cite.click(), async () => {
    await j.page.locator(`main[data-ready="doc:${ref}"], [data-testid="chronology-document-pane"][data-ref="${ref}"]`).first().waitFor();
  });
  j.metadata.citationClicks = 1;
  await j.attempt('split-pane', async () => {
    const list = j.page.locator('[data-testid="chronology-list"]');
    const pane = j.page.locator(`[data-testid="chronology-document-pane"][data-ref="${ref}"]`);
    check(await list.isVisible() && await pane.isVisible(), 'Chronology list and backing document are not simultaneously visible; split pane missing');
    const a = await list.boundingBox(), b = await pane.boundingBox();
    check(a.width > 0 && b.width > 0 && (a.x + a.width <= b.x + 2 || b.x + b.width <= a.x + 2), 'Split panes must be side by side');
    check((await pane.innerText()).trim().length > 0 || await pane.locator('iframe,canvas').count() > 0, 'Backing document pane empty');
    j.results.push({ name: 'split-pane', status: 'PASS' });
  });
});
if (direct(import.meta.url)) await journey();
