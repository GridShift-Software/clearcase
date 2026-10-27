import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import { buildSynth, editPackage, resealFiles, type Built } from './fixtures/build.ts';
import { cleanup } from './fixtures/synth.ts';

function syntheticPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = text.length;
    text += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = text.length;
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
const pdf = syntheticPdf();
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
  it('rejects an unreferenced preview entry', async () => {
    const files = editPackage(packageWithPreview(), 'assets.json', (index) => { delete index.assets['OD-001'].preview; });
    const result = await importCandidate({ files }, b.caseDir);
    expect(result.counts.PKG_PREVIEW_UNREFERENCED).toBeGreaterThan(0);
    expect(result.verdict).toBe('reject');
  });
  it('checks even unreferenced preview bytes for PDF validity', async () => {
    const files = editPackage(packageWithPreview(), 'assets.json', (index) => { delete index.assets['OD-001'].preview; });
    files.set(path, new TextEncoder().encode('not a PDF'));
    const result = await importCandidate({ files: resealFiles(files) }, b.caseDir);
    expect(result.counts.PKG_PREVIEW_INVALID).toBeGreaterThan(0);
    expect(result.counts.PKG_PREVIEW_UNREFERENCED).toBeGreaterThan(0);
  });
  it('rejects a PDF header without a parseable document', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nnot a PDF');
    const files = packageWithPreview((asset) => { asset.preview.sha256 = sha256Hex(bytes); asset.preview.size = bytes.length; });
    files.set(path, bytes);
    const result = await importCandidate({ files: resealFiles(files) }, b.caseDir);
    expect(result.counts.PKG_PREVIEW_INVALID).toBeGreaterThan(0);
    expect(result.verdict).toBe('reject');
  });
  it('rejects a dataset relabelled as preview', async () => {
    const files = resealFiles(b.files, (manifest) => { manifest.files.find((entry: any) => entry.path === 'datasets/chronology.json').role = 'preview'; });
    const result = await importCandidate({ files }, b.caseDir);
    expect(result.verdict).toBe('reject');
    expect(result.counts.PKG_PREVIEW_UNREFERENCED).toBeGreaterThan(0);
    expect(result.counts.PKG_PREVIEW_INVALID).toBeGreaterThan(0);
  });
  it('allows a shared preview only for the same original hash and preview bytes', async () => {
    const files = editPackage(packageWithPreview(), 'assets.json', (index) => { index.assets['OD-002'] = { ...index.assets['OD-001'] }; });
    expect((await importCandidate({ files }, b.caseDir)).verdict).not.toBe('reject');
    const different = editPackage(files, 'assets.json', (index) => {
      index.assets['OD-002'].sha256 = '0'.repeat(64);
      index.assets['OD-002'].preview.originalSha256 = '0'.repeat(64);
    });
    const result = await importCandidate({ files: different }, b.caseDir);
    expect(result.verdict).toBe('reject');
    expect(result.counts.PKG_PREVIEW_BINDING_MISMATCH).toBeGreaterThan(0);
    const differentBytes = editPackage(files, 'assets.json', (index) => { index.assets['OD-002'].preview.sha256 = '0'.repeat(64); });
    expect((await importCandidate({ files: differentBytes }, b.caseDir)).counts.PKG_PREVIEW_BINDING_MISMATCH).toBeGreaterThan(0);
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
