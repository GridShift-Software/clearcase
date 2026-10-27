import { contractError } from '../../../server/runtime/errors.ts';
import type { HeldFile } from '../../../case-package/source.ts';
import { checkRelPath } from '../../../case-package/paths.ts';
import { decodeUtf8Strict, isObject, parseStrictJson } from '../../../case-package/strict-json.ts';
import { inspectPackage, type Inspection } from '../package.ts';
import { STRUCTURED_FILES, type StagedPackageView } from './steps.ts';

/** The non-preview files of a staged package as bytes and its previews as the facts their upload check recorded. */
export interface StagedStructure { readonly files: Map<string, Uint8Array>; readonly held: Map<string, HeldFile>; readonly bytes: number }
export type StagedLoad = { ok: true; value: StagedStructure } | { ok: false; code: 'package-invalid' | 'too-large'; detail: readonly string[] };

const POOL = 6;
async function pool<T, R>(items: readonly T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!); }));
  return out;
}

/**
 * Reads the manifest, the datasets and the asset index of a staged package (each verified against the manifest as it is read), refusing
 * before the first read when they are more than `STRUCTURED_FILES` or more than `maxBytes` together. A preview is never read: its size, SHA-256 and PDF header were
 * recorded when it was uploaded and checked, and the validator is handed those. The manifest was checked when the session opened.
 */
export async function loadStaged(pkg: StagedPackageView, maxBytes: number): Promise<StagedLoad> {
  let listed: { path: string; role: string }[] = [];
  try {
    const m = parseStrictJson(decodeUtf8Strict(pkg.manifest));
    if (isObject(m) && Array.isArray(m.files)) listed = m.files.flatMap((f) => (isObject(f) && typeof f.path === 'string' && typeof f.role === 'string' ? [{ path: f.path, role: f.role }] : []));
  } catch { return { ok: false, code: 'package-invalid', detail: ['manifest.json is not strict JSON'] }; }
  const structured = listed.filter((f) => f.role !== 'preview' && checkRelPath(f.path).ok);
  if (structured.length + 1 > STRUCTURED_FILES) return { ok: false, code: 'too-large', detail: [`the package lists ${structured.length} non-preview files; one step reads at most ${STRUCTURED_FILES - 1}`] };
  let bytes = pkg.manifest.byteLength;
  for (const f of structured) bytes += pkg.files.get(f.path)?.size ?? 0;
  if (bytes > maxBytes) return { ok: false, code: 'too-large', detail: [`the manifest, datasets and asset index together are ${bytes} bytes; one step may hold ${maxBytes}`] };
  const files = new Map<string, Uint8Array>([['manifest.json', pkg.manifest]]);
  const read = await pool(structured.filter((f) => f.path !== 'manifest.json'), async (f) => [f.path, await pkg.read(f.path)] as const);
  for (const [path, data] of read) files.set(path, data);
  const held = new Map<string, HeldFile>();
  for (const f of listed) {
    if (f.role !== 'preview') continue;
    const h = pkg.files.get(f.path);
    if (!h) throw contractError('integrity', false);
    held.set(f.path, { size: h.size, sha256: h.sha256, pdf: h.pdf });
  }
  return { ok: true, value: { files, held, bytes } };
}

/** `inspectPackage` over a staged package's structure: the same checks of identity, case and asset index, with no preview bytes. */
export async function inspectStaged(pkg: StagedPackageView, caseId: string, maxBytes: number): Promise<Inspection | Extract<StagedLoad, { ok: false }>> {
  const loaded = await loadStaged(pkg, maxBytes);
  if (!loaded.ok) return loaded;
  return inspectPackage(loaded.value.files, caseId, loaded.value.held);
}
