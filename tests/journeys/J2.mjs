import { run, direct, ready, check, hook, NEEDS } from './lib.mjs';
// The Overview's three slots (src/lib/components/overview-slots.ts) with their titles and the element that holds each value.
const SLOTS = {
  deadlines: { title: 'Open deadlines', value: '.num' },
  'unbilled-time': { title: 'Unbilled time', value: '.num' },
  'rescan-freshness': { title: 'Freshness', value: '#freshness-stamp' },
};
export const journey = () => run('J2', async j => {
  await j.measure('overview-content', () => j.page.goto(j.url('overview'), { waitUntil: 'domcontentloaded' }), async () => {
    await ready(j.page, 'overview');
    const total = hook(j.page, 'overview-document-count', '#count-documents'); await total.waitFor();
    const count = Number((await total.innerText()).replace(/\D/g, ''));
    // EXPECTED_DOCUMENTS pins the count of the case under test, so a partial import fails here.
    check(count === Number(process.env.EXPECTED_DOCUMENTS), 'Unexpected document count');
    const slots = await j.page.locator('[data-slot]').evaluateAll((es, expected) => es.map(e => {
      const shown = x => !!x && x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden';
      // textContent: the tiles' titles are styled uppercase, which innerText would report
      const text = x => (shown(x) ? x.textContent.replace(/\s+/g, ' ').trim() : '');
      return {
        id: e.dataset.slot, filled: e.dataset.slotStatus === 'filled', shown: shown(e), heading: text(e.querySelector('h2')),
        value: text(e.querySelector(expected[e.dataset.slot]?.value || ':not(*)')),
        failure: [...e.querySelectorAll('.error, [role="alert"]')].some(shown) || /\b(unable to|could not|cannot|not yet available|failed)\b/i.test(e.innerText),
      };
    }), SLOTS);
    check(slots.map(s => s.id).sort().join() === Object.keys(SLOTS).sort().join(), `Overview slots are ${slots.map(s => s.id).join(', ') || 'missing'}, expected ${Object.keys(SLOTS).join(', ')}`);
    for (const s of slots) {
      check(s.filled && s.shown && !s.failure, `Overview slot ${s.id} is not filled or shows a failure`);
      check(s.heading === SLOTS[s.id].title && s.value, `Overview slot ${s.id} does not show its title and value`);
    }
    await j.page.getByRole('heading', { name: 'Dates', exact: true }).waitFor();
    check((await j.page.locator('#date-span').innerText()).trim().length > 0, 'Dates shows no date span');
  });
}, { needs: NEEDS.documents });
if (direct(import.meta.url)) await journey();
