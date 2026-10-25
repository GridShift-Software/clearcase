// Derives the production PDF.js asset tree from the locked pdfjs-dist install into an ignored, per-run directory.
// prepareHostedPdfAssets refuses unless the installed bytes and the reviewed reader match their captured digests.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';

const root = resolve(import.meta.dirname, '../../..');
const parent = join(root, '.local/native-viewer-pdf');
export function generatePdfAssets() {
  mkdirSync(parent, { recursive: true });
  const publicRoot = mkdtempSync(join(parent, 'run-'));
  const inventory = prepareHostedPdfAssets({ root, publicRoot });
  return { inventory, dir: join(publicRoot, 'pdfjs'), dispose: () => rmSync(publicRoot, { recursive: true, force: true }) };
}
