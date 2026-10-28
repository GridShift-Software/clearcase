import { run, direct, ready, check, hook, NEEDS } from './lib.mjs';
export const journey = () => run('J2', async j => {
  await j.measure('overview-content', () => j.page.goto(j.url('overview'), { waitUntil: 'domcontentloaded' }), async () => {
    await ready(j.page, 'overview');
    const total = hook(j.page, 'overview-document-count', '#count-documents'); await total.waitFor();
    const count = Number((await total.innerText()).replace(/\D/g, ''));
    // EXPECTED_DOCUMENTS pins the count of the case under test, so a partial import fails here.
    check(count === Number(process.env.EXPECTED_DOCUMENTS), 'Unexpected document count');
    const slots = j.page.locator('[data-slot]');
    check(await slots.count() > 0, 'Overview slots missing');
    check(await slots.evaluateAll(es => es.every(e => e.dataset.slotStatus === 'filled' && e.textContent.trim().length > 0)), 'Overview slots are not filled');
    await j.page.getByRole('heading', { name: 'Dates', exact: true }).waitFor();
  });
}, { needs: NEEDS.documents });
if (direct(import.meta.url)) await journey();
