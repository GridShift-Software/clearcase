// Decode the complete export using the owning worker's explicitly supplied manifest projection.
// There is deliberately no invented production schema or default: missing owner documentation is a HOLD.
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCentralDirectory, readEntry } from '../../src/lib/case-package/zip.ts';
import { withLimits } from '../../src/lib/case-package/limits.ts';
import { exactKeys, isPlain, SHA, sha256Hex } from './common.ts';
import { pointer } from './routes.ts';
import type { JourneyFixture } from './fixtures.ts';

export interface ExportContract {
  document: string; transport: 'zip'; manifestPath: string;
  schema: { pointer: string; value: string };
  captures: { caseId: string; resultsVersion: string; files: string };
  fileCaptures: { kind: string; assetId: string; path: string; archivePath: string; sha256: string; size: string };
  originalKind: string; previewKind: string;
}
const safePath = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && !s.startsWith('/') && !/[\\\x00-\x1f]/.test(s) && s.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
const pointers = (o: unknown, keys: string[]) => isPlain(o) && exactKeys(o, keys) && Object.values(o).every((v) => typeof v === 'string' && /^(?:\/[^/]+)+$/.test(v));
export function exportContractProblems(c: unknown): string[] {
  if (!isPlain(c)) return ['exportContract from the owning accepted document is required'];
  if (!exactKeys(c, ['document', 'transport', 'manifestPath', 'schema', 'captures', 'fileCaptures', 'originalKind', 'previewKind']) ||
    typeof c.document !== 'string' || !safePath(c.document) || !c.document.startsWith('docs/') || !c.document.endsWith('.md') ||
    c.transport !== 'zip' || !safePath(c.manifestPath) || !isPlain(c.schema) || !exactKeys(c.schema, ['pointer', 'value']) ||
    typeof c.schema.pointer !== 'string' || !/^(?:\/[^/]+)+$/.test(c.schema.pointer) || typeof c.schema.value !== 'string' || !c.schema.value ||
    !pointers(c.captures, ['caseId', 'resultsVersion', 'files']) || !pointers(c.fileCaptures, ['kind', 'assetId', 'path', 'archivePath', 'sha256', 'size']) ||
    typeof c.originalKind !== 'string' || !c.originalKind || typeof c.previewKind !== 'string' || !c.previewKind || c.originalKind === c.previewKind) return ['exportContract must document the ZIP manifest schema, identity and file projections'];
  return [];
}

/** Reuse the package ZIP reader: central-directory, path, duplicate, size, compression and CRC checks, not substring search. */
export async function validateExport(bytes: Uint8Array, c: ExportContract, expected: { caseId: string; assetId: string; fixture: JourneyFixture }): Promise<string[]> {
  const prerequisites = exportContractProblems(c);
  if (prerequisites.length) return prerequisites;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-journey-export-'));
  try {
    const file = path.join(dir, 'export.zip');
    await writeFile(file, bytes);
    const fh = await open(file, 'r');
    try {
      const entries = await readCentralDirectory(fh, withLimits({ archiveTotalBytes: 64 * 1024 * 1024 }));
      const files = entries.filter((e) => !e.isDirectory);
      const manifest = files.find((e) => e.name === c.manifestPath);
      if (!manifest || manifest.uncompressedSize > 1024 * 1024) return ['missing or oversized export manifest'];
      const doc: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readEntry(fh, manifest)));
      if (pointer(doc, c.schema.pointer) !== c.schema.value || pointer(doc, c.captures.caseId) !== expected.caseId || pointer(doc, c.captures.resultsVersion) !== expected.fixture.resultsVersion) return ['export manifest schema, case or published version differs'];
      const rows = pointer(doc, c.captures.files);
      if (!Array.isArray(rows) || rows.length === 0 || rows.length !== files.length - 1) return ['export manifest is not the complete archive inventory'];
      const seen = new Set<string>(), originals: { assetId: unknown; path: unknown; sha256: unknown; size: unknown }[] = [];
      for (const row of rows) {
        const fact = Object.fromEntries(Object.entries(c.fileCaptures).map(([key, ptr]) => [key, pointer(row, ptr)]));
        if (!safePath(fact.archivePath) || !safePath(fact.path) || seen.has(fact.archivePath) || fact.archivePath === c.manifestPath || typeof fact.sha256 !== 'string' || !SHA.test(fact.sha256) || !Number.isSafeInteger(fact.size) || Number(fact.size) < 0 || typeof fact.assetId !== 'string' || !fact.assetId || (fact.kind !== c.originalKind && fact.kind !== c.previewKind)) return ['invalid, duplicate or out-of-scope export file identity'];
        seen.add(fact.archivePath);
        const entry = files.find((e) => e.name === fact.archivePath);
        if (!entry || entry.uncompressedSize !== fact.size || sha256Hex(await readEntry(fh, entry)) !== fact.sha256) return ['export entry missing or bytes differ from manifest'];
        if (fact.kind === c.originalKind) originals.push({ assetId: fact.assetId, path: fact.path, sha256: fact.sha256, size: fact.size });
      }
      const f = expected.fixture, original = originals[0];
      if (originals.length !== 1 || original.assetId !== expected.assetId || original.path !== f.pdf.path || original.sha256 !== f.pdf.sha256 || original.size !== f.pdf.size) return ['export originals differ from this finalized submission'];
      return [];
    } finally { await fh.close(); }
  } catch { return ['export archive or manifest cannot be decoded and verified']; }
  finally { await rm(dir, { recursive: true, force: true }); }
}
