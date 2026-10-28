import { run, direct, samples, NEEDS, MODE, BASE_URL, check } from './lib.mjs';
export const journey = () => run('J7', async j => {
  j.writeAllowed();
  await j.go(`doc/${samples[0].ref}`, `doc:${samples[0].ref}`, 'document');
  const text = await j.saveNote('note-save');
  await j.measure('note-reload', () => j.page.reload({ waitUntil: 'domcontentloaded' }), () => j.page.getByText(text, { exact: true }).waitFor());
  await j.attempt('case-notes-list', async () => {
    await j.measure('case-notes-list', () => j.page.goto(MODE === 'hosted' ? `${BASE_URL}/cases/${encodeURIComponent(process.env.CASE_ID)}/notes` : j.url('overview'), { waitUntil: 'domcontentloaded' }), async () => {
      const list = j.page.locator('[data-testid="case-notes-list"], section[aria-labelledby="kpi-notes"]').first();
      await list.waitFor();
      check(await list.getByText(text, { exact: true }).count() > 0, 'Saved document note absent from case notes list (counts/ref summaries do not prove body visibility)');
      await list.getByText(text, { exact: true }).waitFor();
    });
  });
}, { needs: NEEDS.small, writes: 'all' });
if (direct(import.meta.url)) await journey();
