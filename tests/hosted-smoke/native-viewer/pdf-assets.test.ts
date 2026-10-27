import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as pdfAssets from '../../../scripts/hosted-pdf-assets.ts';
import { generatePdfAssets } from './pdf-assets.ts';

it('cleans only its owned run directory when asset preparation throws', () => {
  const parent = resolve(import.meta.dirname, '../../../.local/native-viewer-pdf');
  mkdirSync(parent, { recursive: true });
  const existing = mkdtempSync(join(parent, 'run-existing-'));
  writeFileSync(join(existing, 'keep'), 'keep');
  let owned = '';
  const failure = new Error('injected preparation failure');
  const spy = vi.spyOn(pdfAssets, 'prepareHostedPdfAssets').mockImplementation(({ publicRoot }) => {
    owned = publicRoot;
    expect(existsSync(owned)).toBe(true);
    writeFileSync(join(owned, 'partial'), 'partial');
    throw failure;
  });
  try {
    expect(() => generatePdfAssets()).toThrow(failure);
    expect(owned).not.toBe(existing);
    expect(existsSync(owned)).toBe(false);
    expect(readFileSync(join(existing, 'keep'), 'utf8')).toBe('keep');
  } finally {
    spy.mockRestore();
    if (owned) rmSync(owned, { recursive: true, force: true });
    rmSync(existing, { recursive: true, force: true });
  }
});
