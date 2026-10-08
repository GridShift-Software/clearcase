// Read-only verification of referenced originals in the operator-selected case folder.
// Only paths named by the asset index are touched: no scanning, no hashing of unrelated
// files and no writes. Each path is resolved with realpath and must stay under the case
// folder (catching symlinks at any depth), must be a regular file and must match the
// indexed size and sha256. Size bounds apply before any byte is hashed; hashing streams in
// bounded chunks and honours the deadline and the abort signal.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiagSink } from './diagnostics.ts';
import type { Limits } from './limits.ts';
import { contentContradictsType } from './media.ts';
import { checkRelPath, foldPath } from './paths.ts';
import type { Asset, FileAsset } from './schema.ts';
import { escapePointer } from './strict-json.ts';

export interface OriginalMapping {
  ref: string;
  /** the real on-disk path relative to the case folder (never normalised) */
  path: string;
  sha256: string;
  size: number;
  mediaType: string;
  status: 'verified' | 'case-mismatch';
  /** content contradicts the declared type: offer only as a download */
  downloadOnly: boolean;
}

export interface Progress { phase: 'snapshot' | 'validate' | 'stat' | 'hash' | 'done'; done: number; total: number; bytesDone: number; bytesTotal: number }

export interface VerifyOptions {
  limits: Limits;
  signal?: AbortSignal;
  deadline: number; // epoch ms
  concurrency: number;
  onProgress?: (p: Progress) => void;
}

export class Interrupted extends Error {
  readonly code: 'IMPORT_DEADLINE' | 'IMPORT_ABORTED';
  constructor(code: 'IMPORT_DEADLINE' | 'IMPORT_ABORTED') {
    super(code);
    this.code = code;
  }
}

type Located =
  | { kind: 'file'; real: string; rel: string; size: number; caseMismatch: boolean }
  | { kind: 'missing' } | { kind: 'escape' } | { kind: 'not-file' } | { kind: 'unreadable' };

export async function openCaseFolder(dir: string, sink: DiagSink): Promise<string | null> {
  const st = await stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) { sink.add('ORIG_CASE_FOLDER_INVALID', 'the case folder is missing or not a directory'); return null; }
  return realpath(dir).catch(() => { sink.add('ORIG_CASE_FOLDER_INVALID', 'the case folder cannot be resolved'); return null; });
}

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

async function locate(root: string, rel: string): Promise<Located> {
  if (!checkRelPath(rel).ok) return { kind: 'escape' };
  let abs = path.join(root, ...rel.split('/'));
  let realRel = rel;
  let caseMismatch = false;
  let ls = await lstat(abs).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : e));
  if (ls instanceof Error) return { kind: 'unreadable' };
  if (!ls) {
    const alt = await findFolded(root, rel);
    if (!alt) return { kind: 'missing' };
    abs = path.join(root, ...alt.split('/'));
    realRel = alt;
    caseMismatch = true;
  }
  const resolved = await realpath(abs).catch(() => null);
  if (!resolved) return { kind: 'missing' }; // dangling link
  if (!inside(root, resolved)) return { kind: 'escape' };
  const rs = await lstat(resolved).catch(() => null);
  if (!rs) return { kind: 'missing' };
  if (!rs.isFile()) return { kind: 'not-file' };
  return { kind: 'file', real: resolved, rel: realRel, size: rs.size, caseMismatch };
}

/** Case- and normalisation-insensitive lookup along the indexed path only; ambiguity counts as missing. */
async function findFolded(root: string, rel: string): Promise<string | null> {
  let cur = root;
  const out: string[] = [];
  for (const seg of rel.split('/')) {
    const names = await readdir(cur).catch(() => null);
    if (!names) return null;
    const hits = names.filter((n) => foldPath(n) === foldPath(seg));
    if (hits.length !== 1) return null;
    out.push(hits[0]!);
    cur = path.join(cur, hits[0]!);
  }
  return out.join('/');
}

function check(o: VerifyOptions): void {
  if (o.signal?.aborted) throw new Interrupted('IMPORT_ABORTED');
  if (Date.now() > o.deadline) throw new Interrupted('IMPORT_DEADLINE');
}

/** Stream-hash one regular file without following a link swapped in after resolution. */
async function hashFile(real: string, expectSize: number, o: VerifyOptions, onBytes: (n: number) => void): Promise<{ sha256: string; size: number; head: Uint8Array }> {
  const fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== expectSize) return { sha256: '', size: st.size, head: new Uint8Array() };
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(1 << 20);
    let size = 0;
    let head: Uint8Array = new Uint8Array();
    for (;;) {
      check(o);
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      if (size === 0) head = new Uint8Array(buf.subarray(0, Math.min(bytesRead, 1024)));
      size += bytesRead;
      if (size > expectSize) break;
      h.update(buf.subarray(0, bytesRead));
      onBytes(bytesRead);
    }
    return { sha256: h.digest('hex'), size, head };
  } finally {
    await fh.close();
  }
}

/**
 * Verify every `file` asset. Returns the verified mapping, the refs whose root original is
 * unavailable, and whether verification completed. Throws Interrupted on deadline or abort.
 */
export async function verifyOriginals(root: string, assets: Record<string, Asset>, sink: DiagSink, o: VerifyOptions): Promise<{ mapping: Map<string, OriginalMapping>; unavailable: Set<string> }> {
  const L = o.limits;
  const mapping = new Map<string, OriginalMapping>();
  const unavailable = new Set<string>();
  const files = Object.entries(assets).filter((e): e is [string, FileAsset] => e[1].kind === 'file');
  for (const [ref, a] of Object.entries(assets)) if (a.kind === 'missing') unavailable.add(ref);
  const progress: Progress = { phase: 'stat', done: 0, total: files.length, bytesDone: 0, bytesTotal: 0 };
  const report = () => o.onProgress?.({ ...progress });

  // 1. locate and stat every referenced original; apply bounds before hashing
  const located = new Map<string, Located>();
  for (const [ref, a] of files) {
    check(o);
    const loc = await locate(root, a.path);
    located.set(ref, loc);
    const at = { file: 'assets.json', pointer: `/assets/${escapePointer(ref)}/path`, subject: ref };
    if (loc.kind === 'missing') { unavailable.add(ref); sink.add('ORIG_MISSING', 'original not found in the selected case folder; the document stays flagged as missing', at); }
    else if (loc.kind === 'escape') { unavailable.add(ref); sink.add('ORIG_ESCAPE', 'original resolves outside the case folder; refused', at); }
    else if (loc.kind === 'not-file') { unavailable.add(ref); sink.add('ORIG_NOT_FILE', 'original is not a regular file; refused', at); }
    else if (loc.kind === 'unreadable') { unavailable.add(ref); sink.add('ORIG_UNREADABLE', 'original cannot be read', at); }
    else {
      if (loc.size > L.originalBytes) sink.add('ORIG_TOO_LARGE', `original is ${loc.size} bytes, above the ${L.originalBytes}-byte bound`, at);
      else if (loc.size !== a.size) sink.add('ORIG_FINGERPRINT_MISMATCH', `size ${loc.size} differs from the indexed ${a.size}`, at);
    }
    progress.done++;
  }
  const unique = new Map<string, number>();
  for (const loc of located.values()) if (loc.kind === 'file') unique.set(loc.real, loc.size);
  let totalBytes = 0;
  for (const s of unique.values()) totalBytes += s;
  if (totalBytes > L.originalsTotalBytes) sink.add('ORIG_TOTAL_TOO_LARGE', `referenced originals total ${totalBytes} bytes, above the ${L.originalsTotalBytes}-byte bound`);
  if (sink.has('ORIG_TOO_LARGE') || sink.has('ORIG_TOTAL_TOO_LARGE')) return { mapping, unavailable };
  report();

  // 2. hash each unique real file once, in parallel, within the deadline
  const jobs = files.filter(([ref, a]) => { const l = located.get(ref)!; return l.kind === 'file' && l.size === a.size; });
  const digests = new Map<string, Promise<{ sha256: string; size: number; head: Uint8Array }>>();
  progress.phase = 'hash';
  progress.done = 0;
  progress.total = jobs.length;
  progress.bytesTotal = [...new Set(jobs.map(([ref]) => (located.get(ref) as { real: string }).real))].reduce((n, r) => n + unique.get(r)!, 0);
  let lastReport = 0;
  const onBytes = (n: number) => { progress.bytesDone += n; if (o.onProgress && progress.bytesDone - lastReport > 64 << 20) { lastReport = progress.bytesDone; report(); } };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [ref, a] = jobs[next++]!;
      const loc = located.get(ref) as Extract<Located, { kind: 'file' }>;
      let p = digests.get(loc.real);
      if (!p) { p = hashFile(loc.real, loc.size, o, onBytes); digests.set(loc.real, p); }
      const at = { file: 'assets.json', pointer: `/assets/${escapePointer(ref)}/path`, subject: ref };
      let fp: { sha256: string; size: number; head: Uint8Array };
      try {
        fp = await p;
      } catch (e) {
        if (e instanceof Interrupted) throw e;
        progress.done++;
        sink.add('ORIG_UNREADABLE', `original cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`, at);
        continue;
      }
      progress.done++;
      if (fp.size !== a.size || fp.sha256 !== a.sha256) { sink.add('ORIG_FINGERPRINT_MISMATCH', 'sha256 differs from the asset index', at); continue; }
      if (loc.caseMismatch) sink.add('ORIG_CASE_MISMATCH', 'found only by a case- or normalisation-insensitive match; the real on-disk name is recorded', at);
      const downloadOnly = contentContradictsType(a.mediaType, fp.head);
      if (downloadOnly) sink.add('ORIG_MEDIA_MISMATCH', `content does not look like ${a.mediaType}; it will only be offered as a download`, at);
      mapping.set(ref, { ref, path: loc.rel, sha256: a.sha256, size: a.size, mediaType: a.mediaType, status: loc.caseMismatch ? 'case-mismatch' : 'verified', downloadOnly });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  progress.phase = 'done';
  report();
  return { mapping, unavailable };
}

/** Locate and fingerprint one referenced original (used by converters). Read-only. */
export async function fingerprintOriginal(root: string, rel: string, o: VerifyOptions): Promise<
  | { kind: 'file'; rel: string; sha256: string; size: number; caseMismatch: boolean }
  | { kind: 'missing' | 'escape' | 'not-file' | 'unreadable' | 'too-large' }> {
  const loc = await locate(root, rel);
  if (loc.kind !== 'file') return { kind: loc.kind };
  if (loc.size > o.limits.originalBytes) return { kind: 'too-large' };
  const fp = await hashFile(loc.real, loc.size, o, () => {});
  if (fp.size !== loc.size) return { kind: 'unreadable' };
  return { kind: 'file', rel: loc.rel, sha256: fp.sha256, size: fp.size, caseMismatch: loc.caseMismatch };
}
