// GRS-251: the viewer's pdf.js worker is the pinned upstream worker with exactly the reviewed patch, and nothing else.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { HOSTED_PDF_VIEWER_WORKER_DIGEST, patchPdfWorker } from '../../../scripts/hosted-pdf-assets.ts';

const upstream = readFileSync(join(resolve(import.meta.dirname, '../../..'), 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'));
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

it('patches the pinned worker to the reviewed bytes: the last-page check is stored, then started by the first drawn page', () => {
  const patched = patchPdfWorker(upstream);
  expect(sha(patched)).toBe(HOSTED_PDF_VIEWER_WORKER_DIGEST);
  const text = patched.toString('utf8');
  // It still blocks the open when /Count is not a positive integer; otherwise it is stored and run after a drawn page.
  expect(text.split('await this.ensureDoc("checkLastPage"').length).toBe(2);
  expect(text.split('if(!(Number.isInteger(clearcaseCount)&&clearcaseCount>0)){await this.ensureDoc("checkLastPage",[e]);return}').length).toBe(2);
  expect(text.split('this.deferredLastPageCheck=()=>').length).toBe(2);
  expect(text.split('clearcasePdfManager.deferredLastPageCheck?.()').length).toBe(2);
  expect(text.split('c.on("ClearcasePageCount",').length).toBe(2);
});

it('refuses a build the patch does not match exactly once, so nothing is half-patched', () => {
  expect(() => patchPdfWorker(patchPdfWorker(upstream))).toThrow(/exactly once/);
  const marker = Buffer.from('await this.ensureDoc("checkFirstPage",[e]);await this.ensureDoc("checkLastPage",[e])}');
  const at = upstream.indexOf(marker);
  expect(() => patchPdfWorker(Buffer.concat([upstream.subarray(0, at), upstream.subarray(at + marker.length - 1)]))).toThrow(/exactly once/);
  expect(() => patchPdfWorker(Buffer.concat([upstream, Buffer.from('\n' + marker.toString())]))).toThrow(/exactly once/);
});
