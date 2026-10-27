import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import { buildSynth, editPackage, resealFiles, type Built } from './fixtures/build.ts';
import { cleanup } from './fixtures/synth.ts';

const pdf = new TextEncoder().encode('%PDF-1.4\nsynthetic preview\n%%EOF\n');
const path = 'previews/OD-001.pdf';
let b: Built;

function packageWithPreview(change?: (asset: any) => void) {
  const files = editPackage(b.files, 'assets.json', (index) => {
    const asset = index.assets['OD-001'];
    asset.mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    asset.preview = { path, sha256: sha256Hex(pdf), size: pdf.length, originalSha256: asset.sha256 };
    change?.(asset);
  });
  files.set(path, pdf);
  return resealFiles(files, (manifest) => {
    manifest.files.push({ path, role: 'preview', sha256: sha256Hex(pdf), size: pdf.length });
  });
}

describe('package PDF previews', () => {
  beforeAll(async () => { b = await buildSynth('preview'); });
  afterAll(async () => { await cleanup(b.root); });
  it('accepts a file asset with a verified PDF preview', async () => {
    const result = await importCandidate({ files: packageWithPreview() }, b.caseDir);
    expect(result.verdict).not.toBe('reject');
    expect(result.candidate?.fileBytes(path)).toEqual(pdf);
  });
  it.each(['sha256', 'size'] as const)('rejects preview with mismatched %s', async (field) => {
    const files = packageWithPreview((asset) => { asset.preview[field] = field === 'sha256' ? '0'.repeat(64) : pdf.length + 1; });
    const result = await importCandidate({ files }, b.caseDir);
    expect(result.verdict).toBe('reject');
  });
  it.each(['hash', 'size'] as const)('rejects preview bytes with a mismatched %s', async (field) => {
    const files = packageWithPreview();
    files.set(path, field === 'hash' ? new Uint8Array(pdf.length).fill(65) : pdf.subarray(0, pdf.length - 1));
    const result = await importCandidate({ files }, b.caseDir);
    expect(result.verdict).toBe('reject');
    expect(result.counts.PKG_FILE_HASH_MISMATCH).toBeGreaterThan(0);
  });
  it('rejects an unlisted preview', async () => {
    const files = resealFiles(packageWithPreview(), (manifest) => { manifest.files = manifest.files.filter((entry: any) => entry.path !== path); });
    expect((await importCandidate({ files }, b.caseDir)).verdict).toBe('reject');
  });
  it('rejects a preview on a missing asset', async () => {
    const files = packageWithPreview((asset) => { delete asset.sha256; delete asset.size; asset.kind = 'missing'; });
    expect((await importCandidate({ files }, b.caseDir)).verdict).toBe('reject');
  });
  it('rejects a preview bound to another original', async () => {
    const files = packageWithPreview((asset) => { asset.preview.originalSha256 = '0'.repeat(64); });
    expect((await importCandidate({ files }, b.caseDir)).verdict).toBe('reject');
  });
});
