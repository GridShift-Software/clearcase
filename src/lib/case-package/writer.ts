// Package writer shared by producers (the v5 adapter, later the pipeline and the Markdown
// round trip). buildPackage is pure and returns exact bytes; writePackageDir writes them to
// an explicit, empty output directory and nowhere else.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalBytes } from './canonical.ts';
import { inputRevisionId, resultsVersionOf, sha256Hex } from './hash.ts';
import type { DatasetKind } from './registry.ts';
import { ASSET_INDEX, ENVELOPE, FORMAT, FORMAT_VERSION, type Asset, type InputSource, type Manifest } from './schema.ts';

export interface DatasetSpec {
  key: string;
  kind: DatasetKind;
  schema: string;
  required: boolean;
  provenance: { source: string; sourcePath: string; adapter: string };
  data: unknown;
}

export interface PackageSpec {
  caseId: string;
  caseLabel?: string;
  inputKind: string;
  sources: InputSource[];
  claims?: Record<string, string | number | null>;
  producer: { name: string; version: string };
  /** deterministic, from the input; never the clock */
  created: string;
  parent?: string | null;
  datasets: DatasetSpec[];
  assets: Record<string, Asset>;
  extensions?: Record<string, unknown>;
}

export const countOf = (data: unknown): number => (Array.isArray(data) ? data.length : data !== null && typeof data === 'object' ? Object.keys(data).length : 1);

export function buildPackage(spec: PackageSpec): { manifest: Manifest; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const entries: Manifest['files'] = [];
  for (const d of [...spec.datasets].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const count = countOf(d.data);
    const bytes = canonicalBytes({ envelope: ENVELOPE, key: d.key, kind: d.kind, schema: d.schema, required: d.required, count, provenance: d.provenance, data: d.data });
    const p = `datasets/${d.key}.json`;
    files.set(p, bytes);
    entries.push({ path: p, role: 'dataset', key: d.key, kind: d.kind, schema: d.schema, required: d.required, count, sha256: sha256Hex(bytes), size: bytes.byteLength });
  }
  const assetsBytes = canonicalBytes({ index: ASSET_INDEX, root: 'case-folder', assets: spec.assets });
  files.set('assets.json', assetsBytes);
  entries.push({ path: 'assets.json', role: 'assets', count: Object.keys(spec.assets).length, sha256: sha256Hex(assetsBytes), size: assetsBytes.byteLength });
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const irId = inputRevisionId(spec.sources);
  const manifest: Manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    case: { id: spec.caseId, ...(spec.caseLabel !== undefined && { label: spec.caseLabel }) },
    inputRevision: { id: irId, kind: spec.inputKind, sources: spec.sources, ...(spec.claims && { claims: spec.claims }) },
    resultsVersion: resultsVersionOf({ formatVersion: FORMAT_VERSION, caseId: spec.caseId, inputRevisionId: irId, files: entries }),
    parent: spec.parent ?? null,
    producer: spec.producer,
    created: spec.created,
    files: entries,
    ...(spec.extensions && { extensions: spec.extensions }),
  };
  files.set('manifest.json', canonicalBytes(manifest));
  return { manifest, files };
}

/** Write package bytes into `outDir`, which must not exist or be empty. Never overwrites. */
export async function writePackageDir(outDir: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length > 0) throw new Error('output directory is not empty');
  for (const p of [...files.keys()].sort()) {
    const abs = path.join(outDir, ...p.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, files.get(p)!, { flag: 'wx' });
  }
}
