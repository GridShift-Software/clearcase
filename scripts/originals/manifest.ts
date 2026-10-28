// GRS-250: turns a converted package's assets.json and the case folder into everything the bulk originals load needs,
// written under --out (always under the ignored .local/): the staging directory of hard links named by sha256, the
// rclone --files-from list, the path -> sha256 manifest, and the D1 SQL. Reads the case folder, never writes into it.
//   bun scripts/originals/manifest.ts --package DIR --case-folder DIR --case-id ID --out DIR [--case-label TEXT] [--etags FILE]
// --etags is etags.ts output (or `rclone lsjson --metadata`) of the stored objects: it fills rs_original.etag, and the run refuses
// when any object is absent, differs in size or has no ETag. Without it the rs_original SQL carries NULL etags.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, readFile, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { serveModeOf } from '../../src/lib/case-package/media.ts';
import { originalKey } from '../../src/lib/storage/cloud/keys.ts';

export const BATCH_ROWS = 50;
/** load.sh's rclone flags: `--s3-chunk-size 64M` and `--s3-upload-cutoff 200M` (rclone's M is MiB). */
export const PART_BYTES = 64 * 1024 * 1024;
export const MULTIPART_FROM = 200 * 1024 * 1024;

/**
 * A file's sha256 and the ETag R2 stores for it once load.sh uploads it: the MD5 of the bytes, or for a multipart upload
 * the S3 composite, the MD5 of the parts' MD5s with `-<parts>`.
 */
export async function digest(file: string, size: number): Promise<{ sha256: string; etag: string }> {
  const sha = createHash('sha256'), whole = createHash('md5'), parts: Buffer[] = [];
  let part = createHash('md5'), filled = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    sha.update(chunk);
    whole.update(chunk);
    for (let at = 0; at < chunk.length;) {
      const take = Math.min(PART_BYTES - filled, chunk.length - at);
      part.update(chunk.subarray(at, at + take));
      filled += take;
      at += take;
      if (filled === PART_BYTES) { parts.push(part.digest()); part = createHash('md5'); filled = 0; }
    }
  }
  if (filled > 0) parts.push(part.digest());
  const etag = size >= MULTIPART_FROM ? `${createHash('md5').update(Buffer.concat(parts)).digest('hex')}-${parts.length}` : whole.digest('hex');
  return { sha256: sha.digest('hex'), etag };
}
export type MediaFamily = 'pdf' | 'image' | 'email-text' | 'download';
export interface ManifestEntry { path: string; sha256: string; size: number; mediaType: string; assetId: string }
export interface Summary { fileAssets: number; uniqueSha256: number; uniqueBytes: number; missing: number; embedded: number; packageFiles: number; sqlBatches: number; etags: number }

/** The delivery family of an original, from its media type's serving policy. */
export function mediaFamily(mediaType: string): MediaFamily {
  if (mediaType === 'application/pdf') return 'pdf';
  const mode = serveModeOf(mediaType);
  if (mode === 'text-sandboxed') return 'email-text';
  if (mode === 'inline-isolated') return 'image';
  return 'download';
}

const SHA = /^[0-9a-f]{64}$/;
const PACKAGE_KEY = /^P-[0-9a-f]{16}$/;
const sq = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`);
const chunks = <T>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const pad = (n: number) => String(n).padStart(4, '0');

/** Referenced file assets: register refs and extracted attachments with bytes. Package files (`P-`), embedded and missing assets get no rows. */
export function readAssets(assetsJson: string): { entries: ManifestEntry[]; missing: number; embedded: number; packageFiles: number } {
  const doc = JSON.parse(assetsJson) as { assets?: Record<string, Record<string, unknown>> };
  if (!doc.assets || typeof doc.assets !== 'object') throw new Error('assets.json has no assets object');
  const entries: ManifestEntry[] = [];
  let missing = 0, embedded = 0, packageFiles = 0;
  for (const [assetId, a] of Object.entries(doc.assets)) {
    if (a.kind === 'embedded') { embedded++; continue; }
    if (a.kind === 'missing') { missing++; continue; }
    if (a.kind !== 'file') throw new Error(`asset ${assetId}: unknown kind`);
    if (PACKAGE_KEY.test(assetId)) { packageFiles++; continue; }
    const { path: p, sha256, size, mediaType } = a;
    if (typeof p !== 'string' || typeof sha256 !== 'string' || !SHA.test(sha256) || !Number.isSafeInteger(size) || typeof mediaType !== 'string') throw new Error(`asset ${assetId}: malformed file entry`);
    entries.push({ path: p, sha256, size: size as number, mediaType, assetId });
  }
  entries.sort((x, y) => (x.assetId < y.assetId ? -1 : x.assetId > y.assetId ? 1 : 0));
  return { entries, missing, embedded, packageFiles };
}

interface Unique { sha256: string; size: number; mediaType: string; path: string }
function uniqueOf(entries: ManifestEntry[]): Unique[] {
  const bySha = new Map<string, Unique>();
  for (const e of entries) {
    const seen = bySha.get(e.sha256);
    if (!seen) bySha.set(e.sha256, { sha256: e.sha256, size: e.size, mediaType: e.mediaType, path: e.path });
    else if (seen.size !== e.size) throw new Error(`asset ${e.assetId}: same sha256 as another asset with a different size`);
  }
  return [...bySha.values()].sort((x, y) => (x.sha256 < y.sha256 ? -1 : 1));
}

interface Remote { size: number; etag: string }
/** etags.ts output (or `rclone lsjson --metadata`) -> sha256 (object name) -> size and ETag, quotes stripped. */
export function readEtags(text: string): Map<string, Remote> {
  const out = new Map<string, Remote>();
  for (const o of JSON.parse(text) as Array<{ Name?: string; Path?: string; Size?: number; IsDir?: boolean; Metadata?: Record<string, string>; Hashes?: Record<string, string> }>) {
    if (o.IsDir) continue;
    const name = (o.Path ?? o.Name ?? '').replace(/^orig\//, '');
    const etag = (o.Metadata?.etag ?? '').replace(/^"|"$/g, '');
    if (SHA.test(name) && typeof o.Size === 'number' && etag) out.set(name, { size: o.Size, etag });
  }
  return out;
}

export function caseSql(caseId: string, caseLabel: string | null): string {
  return `INSERT OR IGNORE INTO rs_case (case_id, case_label) VALUES (${sq(caseId)}, ${sq(caseLabel)});\n`;
}
export function originalSql(rows: Array<Unique & { etag: string | null }>): string {
  const values = rows.map((r) => `(${sq(r.sha256)}, ${r.size}, ${sq(originalKey(r.sha256))}, ${sq(r.etag)}, ${sq(mediaFamily(r.mediaType))})`).join(',\n');
  return `INSERT INTO rs_original (sha256, size, object_key, etag, media_family) VALUES\n${values}\n`
    + 'ON CONFLICT (sha256) DO UPDATE SET etag = COALESCE(excluded.etag, rs_original.etag), media_family = excluded.media_family;\n';
}
export function caseOriginalSql(caseId: string, rows: ManifestEntry[], finalizedAt: string): string {
  const values = rows.map((e) => `(${sq(caseId)}, ${sq(e.assetId)}, ${sq(e.sha256)}, ${sq(e.path.slice(e.path.lastIndexOf('/') + 1))}, ${sq(e.mediaType)}, ${sq(finalizedAt)})`).join(',\n');
  return `INSERT OR IGNORE INTO rs_case_original (case_id, asset_id, sha256, filename, media_type, finalized_at) VALUES\n${values};\n`;
}

export interface Options { packageDir: string; caseFolder: string; caseId: string; out: string; caseLabel?: string; etags?: string; finalizedAt?: string }

export async function build(o: Options): Promise<Summary> {
  const { entries, missing, embedded, packageFiles } = readAssets(await readFile(path.join(o.packageDir, 'assets.json'), 'utf8'));
  const uniques = uniqueOf(entries);
  const root = path.resolve(o.caseFolder);
  // The converter validated these paths against the folder; a size check here catches a folder changed since.
  for (const u of uniques) {
    const abs = path.resolve(root, u.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`a referenced path leaves the case folder (${u.sha256})`);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) throw new Error(`a referenced file is not in the case folder (${u.sha256})`);
    if (st.size !== u.size) throw new Error(`a referenced file's size differs from assets.json (${u.sha256})`);
  }
  const stage = path.join(o.out, 'orig-stage'), sqlDir = path.join(o.out, 'sql');
  await rm(sqlDir, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(sqlDir, { recursive: true });
  const staged = new Set(await readdir(stage));
  // A size check alone passes a same-size edit, so the bytes rclone will upload are hashed, a reused entry included.
  const expected = new Map<string, string>();
  for (const u of uniques) {
    const abs = path.resolve(root, u.path), dest = path.join(stage, u.sha256);
    if (!staged.has(u.sha256)) await link(abs, dest).catch(() => symlink(abs, dest)); // hard link on one filesystem; load.sh passes --copy-links for the fallback
    const d = await digest(dest, u.size);
    if (d.sha256 !== u.sha256) throw new Error(`the staged file for ${u.sha256} does not hash to it`);
    expected.set(u.sha256, d.etag);
  }
  let remote: Map<string, Remote> | null = null;
  if (o.etags) {
    remote = readEtags(await readFile(o.etags, 'utf8'));
    for (const u of uniques) {
      const r = remote.get(u.sha256);
      if (!r) throw new Error(`no stored object with an ETag for ${u.sha256}`);
      if (r.size !== u.size) throw new Error(`stored object size differs from the manifest for ${u.sha256}`);
      if (r.etag !== expected.get(u.sha256)) throw new Error(`stored object's ETag differs from the staged bytes for ${u.sha256}`);
    }
  }
  await writeFile(path.join(o.out, 'files-from.txt'), uniques.map((u) => u.sha256).join('\n') + '\n');
  await writeFile(path.join(o.out, 'manifest.json'), JSON.stringify(entries, null, 1) + '\n');

  let n = 0;
  await writeFile(path.join(sqlDir, `${pad(n++)}-case.sql`), caseSql(o.caseId, o.caseLabel ?? null));
  for (const [i, batch] of chunks(uniques, BATCH_ROWS).entries()) {
    await writeFile(path.join(sqlDir, `${pad(n++)}-original-${pad(i)}.sql`), originalSql(batch.map((u) => ({ ...u, etag: remote?.get(u.sha256)?.etag ?? null }))));
  }
  const finalizedAt = o.finalizedAt ?? new Date().toISOString();
  for (const [i, batch] of chunks(entries, BATCH_ROWS).entries()) {
    await writeFile(path.join(sqlDir, `${pad(n++)}-case-original-${pad(i)}.sql`), caseOriginalSql(o.caseId, batch, finalizedAt));
  }
  return { fileAssets: entries.length, uniqueSha256: uniques.length, uniqueBytes: uniques.reduce((s, u) => s + u.size, 0), missing, embedded, packageFiles, sqlBatches: n, etags: remote ? uniques.length : 0 };
}

function parseArgs(argv: string[]): Options {
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`usage: bun scripts/originals/manifest.ts --package DIR --case-folder DIR --case-id ID --out DIR [--case-label TEXT] [--etags FILE] (bad argument ${k ?? ''})`);
    v.set(k.slice(2), argv[i + 1]!);
  }
  const need = (k: string) => v.get(k) ?? (() => { throw new Error(`missing --${k}`); })();
  const caseId = need('case-id');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(caseId)) throw new Error('--case-id must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  return { packageDir: need('package'), caseFolder: need('case-folder'), caseId, out: need('out'), caseLabel: v.get('case-label'), etags: v.get('etags') };
}

if (import.meta.main) {
  try {
    const s = await build(parseArgs(process.argv.slice(2)));
    console.log(`file assets ${s.fileAssets}; unique sha256 ${s.uniqueSha256}; unique bytes ${s.uniqueBytes}; skipped: ${s.packageFiles} package files, ${s.embedded} embedded, ${s.missing} missing; sql batches ${s.sqlBatches}; etags ${s.etags}`);
  } catch (e) { console.error(`error: ${(e as Error).message}`); process.exit(2); }
}
