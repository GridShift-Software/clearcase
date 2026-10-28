import { run, direct, samples, NEEDS, ready, hook, firstPDF, PDF_MS, check } from './lib.mjs';
export const journey = () => run('J4', async j => {
  for (const sample of samples) await j.attempt(sample.band, async () => {
    await j.go('evidence/documents', 'documents', `${sample.band}:documents-list`);
    const group = j.page.getByRole('button', { name: new RegExp(`^${sample.bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`) });
    if (sample.bundle && await group.count()) {
      await group.click();
      await j.page.locator(`main[data-ready="documents"][data-bundle="${sample.bundle}"]`).waitFor();
    }
    await hook(j.page, 'document-filter', '#doc-filter').fill(sample.ref);
    const link = j.page.locator(`main a[href$="/doc/${sample.ref}"]`).first(); await link.waitFor();
    await j.measure(`${sample.band}:document-page`, () => link.click(), async () => {
      await ready(j.page, `doc:${sample.ref}`);
      await hook(j.page, 'open-original', '#open-original').waitFor();
      if (sample.bytes) {
        const detail = await j.page.locator('#original-state, [data-testid="original-metadata"]').first().innerText();
        check(detail.replace(/,/g, '').includes(String(sample.bytes)), 'Original byte size differs from the expected size');
      }
    });
    let pdf;
    try {
      await j.measure(`${sample.band}:first-pdf-page`, async () => {
        const open = hook(j.page, 'open-original', '#open-original');
        if (await open.getAttribute('target') === '_blank') {
          const popup = j.context.waitForEvent('page'); await open.click(); pdf = await popup;
        } else { await open.click(); pdf = j.page; }
      }, () => firstPDF(pdf), PDF_MS, () => pdf);
    } finally { if (pdf && pdf !== j.page) await pdf.close(); }
  });
}, { needs: NEEDS.samples });
if (direct(import.meta.url)) await journey();
