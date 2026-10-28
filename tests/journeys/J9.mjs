import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { run, direct, hook, check } from './lib.mjs';
export const journey = () => run('J9', async j => {
  j.writeAllowed();
  await j.go('bundles/court_bundle_tab', 'court_bundle_tab');
  await hook(j.page, 'bundle-build', '#cb-build').click();
  const files = [];
  // Synthetic PDFs make this asset portable and never upload original case material.
  for (let i = 1; i <= 2; i++) {
    const stream = `BT /F1 16 Tf 50 750 Td (Acceptance source ${i}) Tj ET\n`;
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    files.push({ name: `journey-source-${i}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  }
  const name = `Journey bundle ${j.metadata.runId} ${Date.now()}`;
  await hook(j.page, 'bundle-name', '#cbbname').fill(name);
  await hook(j.page, 'bundle-files', '#cbbfile').setInputFiles(files);
  await j.measure('bundle-create', () => hook(j.page, 'bundle-create', '#cbbrun').click(), () => hook(j.page, 'bundle-download', '#cbbdownload').waitFor(), Number(process.env.BUNDLE_MS || 5000));
  const file = await j.download('bundle-download', hook(j.page, 'bundle-download', '#cbbdownload'), 'J9-bundle.pdf');
  const bytes = await fs.readFile(file);
  check(bytes.subarray(0, 5).toString() === '%PDF-', 'Download is not a PDF');
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  check(pages >= 3, 'Bundle must contain index plus both source pages');
  const content = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  check(content.includes('Acceptance source 1') && content.includes('Acceptance source 2'), 'Bundle missing a source page');
  j.metadata.bundleBytes = bytes.length; j.metadata.bundlePages = pages;
  await j.measure('bundle-save', () => hook(j.page, 'bundle-save', '#cbbsave').click(), () => j.page.locator('[data-testid="bundle-heading"], #cb-bundle-h').filter({ hasText: name }).waitFor());
  await j.page.getByRole('button', { name: 'All bundles', exact: true }).click();
  const savedRow = j.page.getByRole('row').filter({ hasText: name });
  await savedRow.waitFor();
  await j.measure('bundle-list-reload', () => j.page.reload({ waitUntil: 'domcontentloaded' }), () => savedRow.waitFor());
  // Sprint regression: persisted item metadata alone is insufficient.
  await savedRow.getByRole('button', { name: 'Open', exact: true }).click();
  await j.page.getByRole('tab', { name: 'View bundle', exact: true }).click();
  await j.attempt('bundle-after-reload', async () => {
    const download = j.page.getByRole('link', { name: 'Download PDF', exact: true });
    check(await download.isVisible(), 'Assembled bundle PDF unavailable after reload');
    const second = await j.download('bundle-after-reload', download, 'J9-bundle-reloaded.pdf');
    check((await fs.readFile(second)).equals(bytes), 'Persisted bundle bytes changed');
  });
}, { writes: 'all' });
if (direct(import.meta.url)) await journey();
