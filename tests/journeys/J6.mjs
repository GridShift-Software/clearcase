import { run, direct, hook, samples, NEEDS } from './lib.mjs';
export const journey = () => run('J6', async j => {
  await j.go('evidence/search', 'search');
  const ref = process.env.SEARCH_REF || samples[0].ref;
  await hook(j.page, 'search-input', '#sq').fill(ref);
  await j.measure('search-result', () => hook(j.page, 'search-submit', '#search-run').click(), async () => {
    await j.page.waitForURL(u => u.searchParams.get('q') === ref);
    await j.page.locator(`main a[href$="/doc/${ref}"]`).first().waitFor();
  });
}, { needs: process.env.SEARCH_REF ? [] : NEEDS.small });
if (direct(import.meta.url)) await journey();
