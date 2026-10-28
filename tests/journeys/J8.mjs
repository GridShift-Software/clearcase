import fs from 'node:fs/promises';
import { run, direct, hook, check } from './lib.mjs';
export const journey = () => run('J8', async j => {
  j.writeAllowed();
  await j.go('registers/deadlines_tab', 'deadlines_tab');
  const title = `Journey deadline ${j.metadata.runId} ${Date.now()}`;
  const date = process.env.DEADLINE_DATE || '2026-11-04';
  await hook(j.page, 'deadline-title', '#in-title').fill(title);
  await hook(j.page, 'deadline-date', '#in-date').fill(date);
  await hook(j.page, 'deadline-note', '#in-note').fill('Synthetic acceptance journey');
  await j.measure('deadline-save', () => hook(j.page, 'deadline-save', '#register-save').click(), () => j.page.getByRole('cell', { name: title, exact: true }).waitFor());
  await j.measure('deadline-reload', () => j.page.reload({ waitUntil: 'domcontentloaded' }), () => j.page.getByRole('cell', { name: title, exact: true }).waitFor());
  const file = await j.download('calendar-download', hook(j.page, 'deadline-export', '#register-export'), 'J8-deadlines.ics');
  const ics = (await fs.readFile(file, 'utf8')).replace(/\r?\n[ \t]/g, '');
  check(ics.includes('BEGIN:VCALENDAR') && ics.includes('END:VCALENDAR'), 'Invalid calendar envelope');
  check(ics.split('BEGIN:VEVENT').some(event => event.includes(`SUMMARY:${title}`) && event.includes(date.replaceAll('-', '')) && event.includes('END:VEVENT')), 'Saved deadline missing from downloaded calendar');
  j.results.push({ name: 'ics-content', status: 'PASS' });
}, { writes: 'all' });
if (direct(import.meta.url)) await journey();
