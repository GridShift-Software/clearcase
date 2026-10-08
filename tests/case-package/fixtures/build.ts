// Build a synthetic package on disk: case folder + converted package in a fresh temp root.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { convertV5, type ConvertResult } from '../../../src/lib/case-package/v5/adapter.ts';
import { writePackageDir } from '../../../src/lib/case-package/writer.ts';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../../src/lib/case-package/strict-json.ts';
import { resultsVersionOf } from '../../../src/lib/case-package/hash.ts';
import { synthHtml, synthRoots, tempDir, writeCaseFolder, type SynthRoots } from './synth.ts';

export interface Built { root: string; caseDir: string; pkgDir: string; html: Uint8Array; result: ConvertResult; files: Map<string, Uint8Array> }

export async function buildSynth(tag: string, edit?: (r: SynthRoots) => void, opts: { concurrency?: number; htmlName?: string; caseId?: string } = {}): Promise<Built> {
  const root = await tempDir(tag);
  const caseDir = path.join(root, 'case');
  const pkgDir = path.join(root, 'pkg');
  await writeCaseFolder(caseDir);
  const roots = synthRoots();
  edit?.(roots);
  const html = synthHtml(roots);
  const result = await convertV5({ html, htmlName: opts.htmlName ?? 'workspace.html', caseFolder: caseDir, caseId: opts.caseId ?? 'synthetic-case', concurrency: opts.concurrency });
  if (!result.files) throw new Error('synthetic conversion failed: ' + result.diagnostics.map((d) => d.code).join(','));
  await writePackageDir(pkgDir, result.files);
  return { root, caseDir, pkgDir, html, result, files: result.files };
}

/** Rewrite one JSON file of an in-memory package canonically and reseal sizes, hashes and identity. */
export function editPackage(files: Map<string, Uint8Array>, file: string, edit: (v: any) => void, reseal = true): Map<string, Uint8Array> {
  const out = new Map(files);
  const v = parseStrictJson(decodeUtf8Strict(out.get(file)!)) as any;
  edit(v);
  out.set(file, canonicalBytes(v));
  return reseal ? resealFiles(out) : out;
}

/** Recompute every listed size and sha256, the resultsVersion, and rewrite the manifest canonically. */
export function resealFiles(files: Map<string, Uint8Array>, editManifest?: (m: any) => void): Map<string, Uint8Array> {
  const out = new Map(files);
  const m = parseStrictJson(decodeUtf8Strict(out.get('manifest.json')!)) as any;
  for (const f of m.files) {
    const b = out.get(f.path);
    if (b) { f.size = b.byteLength; f.sha256 = sha256Hex(b); }
    if (f.role === 'dataset' && b) {
      try { const env = parseStrictJson(decodeUtf8Strict(b)) as any; f.count = env.count; } catch { /* malformed on purpose */ }
    }
  }
  editManifest?.(m);
  try {
    m.resultsVersion = resultsVersionOf({ formatVersion: m.formatVersion, caseId: m.case.id, inputRevisionId: m.inputRevision.id, files: m.files });
  } catch { /* an edit removed an identity input on purpose */ }
  out.set('manifest.json', canonicalBytes(m));
  return out;
}

/** Edit the manifest canonically without recomputing anything (to test integrity checks). */
export function editManifestOnly(files: Map<string, Uint8Array>, edit: (m: any) => void): Map<string, Uint8Array> {
  const out = new Map(files);
  const m = parseStrictJson(decodeUtf8Strict(out.get('manifest.json')!)) as any;
  edit(m);
  out.set('manifest.json', canonicalBytes(m));
  return out;
}

export const readJson = async (p: string) => parseStrictJson(await readFile(p, 'utf8')) as any;
