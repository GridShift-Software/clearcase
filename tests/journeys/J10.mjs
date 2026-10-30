import { run, direct, samples, NEEDS, ready, check } from './lib.mjs';
export const journey = () => run('J10', async j => {
  // READ_ONLY=1 keeps the idle, the navigation and the document visit, and reports the note save and its reload as skipped.
  const readOnly = process.env.READ_ONLY === '1';
  if (!readOnly) j.writeAllowed();
  const minutes = Number(process.env.IDLE_MINUTES || 20);
  check(Number.isFinite(minutes) && minutes > 0, 'IDLE_MINUTES must be positive');
  await j.go(`doc/${samples[0].ref}`, `doc:${samples[0].ref}`, 'before-idle');
  j.metadata.idleMinutes = minutes;
  // No navigation, request injection, page evaluation, or keepalive during this interval.
  const start = performance.now();
  await new Promise(resolve => setTimeout(resolve, minutes * 60000));
  j.metadata.idleMs = Math.round(performance.now() - start);
  await j.nav('chronology');
  await j.go(`doc/${samples[0].ref}`, `doc:${samples[0].ref}`, 'resume-document');
  if (readOnly) {
    for (const name of ['save-after-idle', 'saved-after-idle-reload']) j.results.push({ name, status: 'SKIPPED', reason: 'READ_ONLY=1' });
    await j.measure('reload-after-idle', () => j.page.reload({ waitUntil: 'domcontentloaded' }), () => ready(j.page, `doc:${samples[0].ref}`));
  } else {
    const text = await j.saveNote('save-after-idle');
    await j.measure('saved-after-idle-reload', () => j.page.reload({ waitUntil: 'domcontentloaded' }), () => j.page.getByText(text, { exact: true }).waitFor());
  }
  check(j.network.status401 === 0 && j.network.status503 === 0, '401 or 503 occurred across session');
  j.results.push({ name: 'session-survival', status: 'PASS' });
}, { needs: NEEDS.small });
if (direct(import.meta.url)) await journey();
