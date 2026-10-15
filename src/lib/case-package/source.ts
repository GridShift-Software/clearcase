import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DiagSink } from './diagnostics.ts';
import type { Limits } from './limits.ts';
import { checkRelPath } from './paths.ts';
import { decodeUtf8Strict, isObject, parseStrictJson } from './strict-json.ts';
import { readCentralDirectory, readEntry, ZipError } from './zip.ts';

export type PackageSource = string | { files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>> };

export interface Snapshot {
  files: Map<string, Uint8Array>;
  present: Map<string, number>;
  transport: 'directory' | 'zip' | 'memory';
}

function listedPaths(manifest: Uint8Array): string[] {
  try {
    const m = parseStrictJson(decodeUtf8Strict(manifest));
    if (!isObject(m) || !Array.isArray(m.files)) return [];
    return m.files.flatMap((f) => (isObject(f) && typeof f.path === 'string' && checkRelPath(f.path).ok ? [f.path] : []));
  } catch {
    return [];
  }
}

export async function snapshotSource(source: PackageSource, L: Limits, sink: DiagSink): Promise<Snapshot | null> {
  if (typeof source !== 'string') return snapshotMemory(source.files, L, sink);
  const st = await lstat(source).catch(() => null);
  if (!st) { sink.add('PKG_SOURCE_INVALID', 'package source not found'); return null; }
  if (st.isSymbolicLink()) { sink.add('PKG_SOURCE_INVALID', 'package source is a symlink; select the real directory or file'); return null; }
  if (st.isDirectory()) return snapshotDirectory(source, L, sink);
  if (st.isFile()) return snapshotZip(source, L, sink);
  sink.add('PKG_SOURCE_INVALID', 'package source is neither a directory nor a regular file');
  return null;
}

async function snapshotDirectory(root: string, L: Limits, sink: DiagSink): Promise<Snapshot | null> {
  const present = new Map<string, number>();
  let total = 0;
  const walk = async (rel: string, depth: number): Promise<boolean> => {
    if (depth > L.pathSegments) { sink.add('PKG_PATH_INVALID', 'folders nested too deeply', { subject: rel }); return false; }
    const names = (await readdir(path.join(root, rel))).sort();
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const s = await lstat(path.join(root, r));
      if (s.isSymbolicLink()) { sink.add('PKG_SYMLINK', 'symlinks are not allowed in a package', { file: r, subject: r }); continue; }
      if (s.isDirectory()) { if (!(await walk(r, depth + 1))) return false; continue; }
      if (!s.isFile()) { sink.add('PKG_SPECIAL_FILE', 'only regular files are allowed', { file: r, subject: r }); continue; }
      present.set(r, s.size);
      total += s.size;
      if (present.size > L.packageFiles) { sink.add('PKG_TOO_MANY_FILES', `more than ${L.packageFiles} files in the package folder`); return false; }
      if (total > L.packageBytes) { sink.add('PKG_TOO_LARGE', `package folder holds more than ${L.packageBytes} bytes`); return false; }
    }
    return true;
  };
  if (!(await walk('', 0))) return null;
  const files = new Map<string, Uint8Array>();
  const readOne = async (rel: string, max: number): Promise<void> => {
    const size = present.get(rel);
    if (size === undefined || size > max) return;
    const fh = await open(path.join(root, ...rel.split('/')), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!fh) return;
    try {
      const s = await fh.stat();
      if (!s.isFile() || s.size > max) return;
      const buf = Buffer.alloc(s.size);
      const { bytesRead } = await fh.read(buf, 0, s.size, 0);
      files.set(rel, new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
    } finally {
      await fh.close();
    }
  };
  await readOne('manifest.json', L.manifestBytes);
  const manifest = files.get('manifest.json');
  if (manifest) for (const p of new Set(listedPaths(manifest))) if (p !== 'manifest.json') await readOne(p, L.fileBytes);
  return { files, present, transport: 'directory' };
}

async function snapshotZip(file: string, L: Limits, sink: DiagSink): Promise<Snapshot | null> {
  // O_NOFOLLOW | O_NONBLOCK: a link or FIFO swapped in after the lstat is refused, never followed or waited on
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!fh) { sink.add('PKG_SOURCE_INVALID', 'the package file cannot be opened as a regular file'); return null; }
  try {
    if (!(await fh.stat()).isFile()) { sink.add('PKG_SOURCE_INVALID', 'the package file is not a regular file'); return null; }
    const entries = await readCentralDirectory(fh, L);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const present = new Map(entries.map((e) => [e.name, e.uncompressedSize]));
    const files = new Map<string, Uint8Array>();
    const m = byName.get('manifest.json');
    if (m && m.uncompressedSize <= L.manifestBytes) files.set('manifest.json', await readEntry(fh, m));
    const manifest = files.get('manifest.json');
    if (manifest) {
      for (const p of new Set(listedPaths(manifest))) {
        const e = byName.get(p);
        if (e && p !== 'manifest.json' && e.uncompressedSize <= L.fileBytes) files.set(p, await readEntry(fh, e));
      }
    }
    return { files, present, transport: 'zip' };
  } catch (err) {
    if (err instanceof ZipError) { sink.add(err.code, err.message, { subject: err.entry }); return null; }
    throw err;
  } finally {
    await fh.close();
  }
}

function snapshotMemory(input: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>, L: Limits, sink: DiagSink): Snapshot | null {
  const entries: [string, Uint8Array][] = input instanceof Map ? [...input.entries()] : Object.entries(input as Record<string, Uint8Array>);
  const present = new Map<string, number>();
  const all = new Map<string, Uint8Array>();
  let total = 0;
  for (const [p, b] of entries) {
    if (!(b instanceof Uint8Array)) { sink.add('PKG_SOURCE_INVALID', 'every value must be a Uint8Array', { subject: String(p).slice(0, 200) }); return null; }
    const v = checkRelPath(p);
    if (!v.ok) { sink.add(v.traversal ? 'PKG_PATH_TRAVERSAL' : 'PKG_PATH_INVALID', v.reason, { subject: String(p).slice(0, 200) }); continue; }
    present.set(p, b.byteLength);
    all.set(p, b);
    total += b.byteLength;
    if (present.size > L.packageFiles) { sink.add('PKG_TOO_MANY_FILES', `more than ${L.packageFiles} files`); return null; }
    if (total > L.packageBytes) { sink.add('PKG_TOO_LARGE', `more than ${L.packageBytes} bytes`); return null; }
  }
  const files = new Map<string, Uint8Array>();
  const copy = (p: string, max: number) => { const b = all.get(p); if (b && b.byteLength <= max) files.set(p, new Uint8Array(b)); };
  copy('manifest.json', L.manifestBytes);
  const manifest = files.get('manifest.json');
  if (manifest) for (const p of new Set(listedPaths(manifest))) if (p !== 'manifest.json') copy(p, L.fileBytes);
  return { files, present, transport: 'memory' };
}
