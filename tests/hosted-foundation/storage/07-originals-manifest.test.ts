// GRS-250: the originals manifest over a synthetic case folder. Every byte and name is invented here; no case material is read.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build, mediaFamily, BATCH_ROWS } from '../../../scripts/originals/manifest.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { SqliteD1 } from './doubles.ts';
import { pdf } from './fixture.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const MIGRATIONS = path.join(import.meta.dirname, '../../../src/lib/storage/cloud/migrations');
const STAGING_MIGRATIONS = path.join(import.meta.dirname, '../../../deploy/staging/migrations');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'cc-originals-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

interface Spec { id: string; kind?: string; rel?: string; bytes?: Uint8Array; mediaType?: string }
/** A case folder and a package directory holding only assets.json, as the converter would leave them. */
async function fixture(specs: Spec[]) {
  const folder = path.join(dir, 'case'), pkg = path.join(dir, 'pkg'), out = path.join(dir, 'out');
  await mkdir(folder, { recursive: true });
  await mkdir(pkg, { recursive: true });
  const assets: Record<string, unknown> = {};
  for (const s of specs) {
    if (s.kind === 'embedded') assets[s.id] = { kind: 'embedded', parentRef: 'EM-0001', ordinal: 1, member: 'x.png', mediaType: 'image/png', textStatus: 'unsupported' };
    else if (s.kind === 'missing') assets[s.id] = { kind: 'missing', path: s.rel, mediaType: 'application/pdf', textStatus: 'pending' };
    else {
      await mkdir(path.dirname(path.join(folder, s.rel!)), { recursive: true });
      await writeFile(path.join(folder, s.rel!), s.bytes!);
      assets[s.id] = { kind: 'file', path: s.rel, sha256: sha256Hex(s.bytes!), size: s.bytes!.byteLength, mediaType: s.mediaType ?? 'application/pdf', textStatus: 'pending' };
    }
  }
  await writeFile(path.join(pkg, 'assets.json'), JSON.stringify({ index: 'clearcase.assets/1', root: 'case-folder', assets }));
  return { folder, pkg, out };
}
const apply = async (db: SqliteD1, out: string) => {
  for (const f of (await readdir(path.join(out, 'sql'))).sort()) db.sqlite.exec(readFileSync(path.join(out, 'sql', f), 'utf8'));
};
const count = (db: SqliteD1, table: string) => (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const SAME = pdf('same');
const SPECS: Spec[] = [
  { id: 'OD-001', rel: 'A/OD-001 one.pdf', bytes: pdf('one') },
  { id: 'OD-002', rel: 'A/OD-002 same.pdf', bytes: SAME },
  { id: 'OD-003', rel: 'B/OD-003 same again.pdf', bytes: SAME },
  { id: 'EM-0001', rel: "B/it's mail.eml", bytes: utf8('From: a@example.invalid\n\nSYNTHETIC\n'), mediaType: 'message/rfc822' },
  { id: 'IM-0001', rel: 'B/photo.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' },
  { id: 'WD-0001', rel: 'B/letter.docx', bytes: utf8('PK synthetic'), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'EM-0001.a1', kind: 'embedded' },
  { id: 'OD-009', kind: 'missing', rel: 'A/gone.pdf' },
  { id: 'P-0123456789abcdef', rel: 'BUNDLES/Bundle.pdf', bytes: pdf('bundle') },
];

describe('GRS-250 originals manifest', () => {
  it('lists one object per unique sha256 and one case row per file asset, skipping embedded, missing and package files', async () => {
    const f = await fixture(SPECS);
    const s = await build({ packageDir: f.pkg, caseFolder: f.folder, caseId: 'v5-demo', out: f.out, finalizedAt: '2001-01-01T00:00:00Z' });
    expect(s).toMatchObject({ fileAssets: 6, uniqueSha256: 5, embedded: 1, missing: 1, packageFiles: 1 });
    const list = (await readFile(path.join(f.out, 'files-from.txt'), 'utf8')).trim().split('\n');
    expect(list).toHaveLength(5);
    expect(new Set(list).size).toBe(5);
    expect((await readdir(path.join(f.out, 'orig-stage'))).sort()).toEqual([...list].sort());
    expect(await readFile(path.join(f.out, 'orig-stage', sha256Hex(SAME)))).toEqual(Buffer.from(SAME));
    const manifest = JSON.parse(await readFile(path.join(f.out, 'manifest.json'), 'utf8')) as Array<{ assetId: string }>;
    expect(manifest.map((m) => m.assetId)).toEqual(['EM-0001', 'IM-0001', 'OD-001', 'OD-002', 'OD-003', 'WD-0001']);
  });

  it('writes SQL that applies cleanly to a fresh D1 after migration 0003, with one rs_original row per shared sha256', async () => {
    const f = await fixture(SPECS);
    await build({ packageDir: f.pkg, caseFolder: f.folder, caseId: 'v5-demo', out: f.out, caseLabel: 'Synthetic', finalizedAt: '2001-01-01T00:00:00Z' });
    const db = new SqliteD1();
    await apply(db, f.out);
    expect(count(db, 'rs_case')).toBe(1);
    expect(count(db, 'rs_original')).toBe(5);
    expect(count(db, 'rs_case_original')).toBe(6);
    const families = db.sqlite.prepare('SELECT media_family AS m, count(*) AS n FROM rs_case_original c JOIN rs_original o USING (sha256) GROUP BY 1 ORDER BY 1').all();
    expect(families).toEqual([{ m: 'download', n: 1 }, { m: 'email-text', n: 1 }, { m: 'image', n: 1 }, { m: 'pdf', n: 3 }]);
    const name = db.sqlite.prepare("SELECT filename FROM rs_case_original WHERE asset_id = 'EM-0001'").get() as { filename: string };
    expect(name.filename).toBe("it's mail.eml");
    const key = db.sqlite.prepare('SELECT object_key AS k FROM rs_original WHERE sha256 = ?').get(sha256Hex(SAME)) as { k: string };
    expect(key.k).toBe(`orig/${sha256Hex(SAME)}`);
  });

  it('fills the ETags from the stored-object listing, is idempotent when applied twice, and keeps an ETag a later run lacks', async () => {
    const f = await fixture(SPECS);
    const base = { packageDir: f.pkg, caseFolder: f.folder, caseId: 'v5-demo', out: f.out, finalizedAt: '2001-01-01T00:00:00Z' };
    await build(base);
    const names = (await readFile(path.join(f.out, 'files-from.txt'), 'utf8')).trim().split('\n');
    const ls = names.map((n, i) => ({ Path: n, Name: n, Size: SPECS.map((s) => s.bytes).filter(Boolean).map((b) => ({ n: sha256Hex(b!), size: b!.byteLength })).find((x) => x.n === n)!.size, IsDir: false, Metadata: { etag: `"etag-${i}"` } }));
    const lsjson = path.join(dir, 'ls.json');
    await writeFile(lsjson, JSON.stringify(ls));
    const s = await build({ ...base, etags: lsjson });
    expect(s.etags).toBe(5);
    const db = new SqliteD1();
    await apply(db, f.out);
    await apply(db, f.out);
    expect(count(db, 'rs_original')).toBe(5);
    expect(count(db, 'rs_case_original')).toBe(6);
    expect(count(db, "rs_original WHERE etag IS NULL")).toBe(0);
    expect((db.sqlite.prepare('SELECT etag FROM rs_original WHERE sha256 = ?').get(names[0]) as { etag: string }).etag).toBe('etag-0');
    await build(base); // no ETags this time: the stored ones stay
    await apply(db, f.out);
    expect(count(db, "rs_original WHERE etag IS NULL")).toBe(0);
  });

  it('refuses a listing that lacks an object, or whose size differs', async () => {
    const f = await fixture(SPECS);
    const base = { packageDir: f.pkg, caseFolder: f.folder, caseId: 'v5-demo', out: f.out };
    const lsjson = path.join(dir, 'ls.json');
    await writeFile(lsjson, '[]');
    await expect(build({ ...base, etags: lsjson })).rejects.toThrow(/no stored object/);
    const sha = sha256Hex(pdf('one'));
    await writeFile(lsjson, JSON.stringify([{ Path: sha, Size: 1, Metadata: { etag: 'x' } }]));
    await expect(build({ ...base, etags: lsjson })).rejects.toThrow(/no stored object|size differs/);
  });

  it('splits into batches of 50 rows', async () => {
    const specs: Spec[] = Array.from({ length: 120 }, (_, i) => ({ id: `OD-${String(i + 1).padStart(3, '0')}`, rel: `A/${i}.pdf`, bytes: pdf(`n${i}`) }));
    const f = await fixture(specs);
    const s = await build({ packageDir: f.pkg, caseFolder: f.folder, caseId: 'v5-demo', out: f.out });
    expect(BATCH_ROWS).toBe(50);
    expect(s.uniqueSha256).toBe(120);
    expect(s.sqlBatches).toBe(1 + 3 + 3);
    const db = new SqliteD1();
    await apply(db, f.out);
    expect(count(db, 'rs_original')).toBe(120);
    expect(count(db, 'rs_case_original')).toBe(120);
  });

  it('refuses a case folder that changed since the conversion', async () => {
    const f = await fixture(SPECS);
    await writeFile(path.join(f.folder, 'A/OD-001 one.pdf'), pdf('changed and longer'));
    await expect(build({ packageDir: f.pkg, caseFolder: f.folder, caseId: 'v5-demo', out: f.out })).rejects.toThrow(/size differs/);
  });

  it('runs as a command and takes the ETag listing from --etags', async () => {
    const f = await fixture(SPECS);
    const run = (...extra: string[]) => execFileSync('bun', ['scripts/originals/manifest.ts', '--package', f.pkg, '--case-folder', f.folder, '--case-id', 'v5-demo', '--out', f.out, ...extra], { cwd: path.join(import.meta.dirname, '../../..'), encoding: 'utf8' });
    expect(run()).toMatch(/file assets 6; unique sha256 5;.*etags 0/);
    const names = (await readFile(path.join(f.out, 'files-from.txt'), 'utf8')).trim().split('\n');
    const bySha = new Map(SPECS.filter((s) => s.bytes).map((s) => [sha256Hex(s.bytes!), s.bytes!.byteLength]));
    const etags = path.join(dir, 'etags.json');
    await writeFile(etags, JSON.stringify(names.map((n) => ({ Path: n, Size: bySha.get(n), Metadata: { etag: 'e' } }))));
    expect(run('--etags', etags)).toMatch(/etags 5/);
  });

  it('maps media types to delivery families', () => {
    expect(mediaFamily('application/pdf')).toBe('pdf');
    expect(mediaFamily('image/jpeg')).toBe('image');
    expect(mediaFamily('message/rfc822')).toBe('email-text');
    expect(mediaFamily('text/plain')).toBe('email-text');
    expect(mediaFamily('application/vnd.ms-outlook')).toBe('download');
    expect(mediaFamily('image/tiff')).toBe('download');
    expect(mediaFamily('application/octet-stream')).toBe('download');
  });

  it('keeps the staging copy of migration 0003 byte-identical', () => {
    expect(readFileSync(path.join(STAGING_MIGRATIONS, '0009_rs_original_etag.sql'))).toEqual(readFileSync(path.join(MIGRATIONS, '0003_rs_original_etag.sql')));
  });
});
