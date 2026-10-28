import { run, direct, ready, check, hook } from './lib.mjs';
export const journey = () => run('J2', async j => {
  await j.measure('overview-content', () => j.page.goto(j.url('overview'), { waitUntil: 'domcontentloaded' }), async () => {
    await ready(j.page, 'overview');
    const total = hook(j.page, 'overview-document-count', '#count-documents'); await total.waitFor();
    const count = Number((await total.innerText()).replace(/\D/g, ''));
    // EXPECTED_DOCUMENTS pins the count of the case under test; without it the count only has to be positive.
    if (process.env.EXPECTED_DOCUMENTS) check(count === Number(process.env.EXPECTED_DOCUMENTS), 'Unexpected document count');
    else { check(count > 0, 'Overview shows no documents'); j.metadata.documentCountPinned = false; }
    const slots = j.page.locator('[data-slot]');
    check(await slots.count() > 0, 'Overview slots missing');
    check(await slots.evaluateAll(es => es.every(e => e.dataset.slotStatus === 'filled' && e.textContent.trim().length > 0)), 'Overview slots are not filled');
    await j.page.getByRole('heading', { name: 'Dates', exact: true }).waitFor();
  });
});
if (direct(import.meta.url)) await journey();
