import { run, direct, ready, check } from './lib.mjs';
export const journey = () => run('J1', async j => {
  await j.go('overview', 'overview', 'shell');
  const nav = j.page.getByRole('navigation', { name: 'Case views' });
  await nav.waitFor();
  const entries = await nav.locator('a').evaluateAll(es => es.filter(e => e.getClientRects().length).map(e => ({ id: e.dataset.view, href: e.getAttribute('href') })));
  check(entries.length > 0, 'No visible navigation entries');
  check(entries.every(e => e.id), 'Every navigation link needs data-view');
  j.metadata.visibleNavEntries = entries.length;
  for (const e of entries) await j.attempt(`nav:${e.id}`, () => j.measure(`nav:${e.id}`, () => nav.locator(`[data-view="${e.id}"]`).click(), async () => {
    await ready(j.page, e.id);
    check(new URL(j.page.url()).pathname === new URL(e.href, j.page.url()).pathname, 'Navigation opened wrong route');
  }));
});
if (direct(import.meta.url)) await journey();
