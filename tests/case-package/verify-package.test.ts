// verify:package lane 09 on a read-only case folder: the lane flips one byte of an original inside its own disposable
// copy of the case folder, so the copy must be writable when every source file is 0444 (and every folder 0555), and
// the source must keep its modes and bytes. Runs the real script with --lanes 9 on a synthetic case.
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import { synthHtml, synthRoots, tempDir, writeCaseFolder } from './fixtures/synth.ts';

const repo = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) {
    spawnSync('chmod', ['-R', 'u+w', d]);
    await rm(d, { recursive: true, force: true });
  }
});

/** Every entry under dir (folders included) with its mode, and each file's sha256. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath, e.name);
    const mode = ((await stat(p)).mode & 0o7777).toString(8);
    out.set(path.relative(dir, p), e.isFile() ? `${mode} ${sha256Hex(await readFile(p))}` : mode);
  }
  return out;
}

describe('verify:package lane 09 with a read-only case folder', () => {
  it('flips its byte in a writable copy and leaves the source modes and bytes unchanged', async () => {
    const root = await tempDir('verify-package');
    dirs.push(root);
    const caseDir = path.join(root, 'case');
    await writeCaseFolder(caseDir);
    const html = synthHtml(synthRoots());
    const htmlPath = path.join(root, 'workspace.html');
    await writeFile(htmlPath, html);
    // read-only like the real fixture: files 0444, and folders 0555 too
    const entries = (await readdir(caseDir, { recursive: true, withFileTypes: true })).map((e) => ({ p: path.join(e.parentPath, e.name), dir: e.isDirectory() }));
    for (const e of entries) await chmod(e.p, e.dir ? 0o555 : 0o444);
    await chmod(caseDir, 0o555);
    const before = await snapshot(caseDir);
    expect([...before.values()].filter((v) => v.includes(' ')).every((v) => v.startsWith('444 '))).toBe(true);
    // the precondition the lane failed on: this process cannot write a 0444 file (namespace root could)
    if (process.getuid?.() !== 0) {
      const first = entries.find((x) => !x.dir)!.p;
      await expect(writeFile(first, 'x')).rejects.toMatchObject({ code: 'EACCES' });
    }

    // the script's work directory must be a subfolder of this worktree's ignored .local/
    await mkdir(path.join(repo, '.local'), { recursive: true });
    const workDir = path.join('.local', path.basename(root) + '-work');
    dirs.push(path.join(repo, workDir));
    const config = path.join(root, 'fixture.json');
    const htmlRef = { path: htmlPath, sha256: sha256Hex(html) };
    await writeFile(config, JSON.stringify({ caseFolder: caseDir, mainHtml: htmlRef, bundlesOnlyHtml: htmlRef, references: { inventory: '', summary: '' }, caseId: 'synthetic-case', workDir }));
    const out = path.join(root, 'out');
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts/case-package/verify-package.ts'), '--fixture-config', config, '--out', out, '--lanes', '9'], { cwd: repo, encoding: 'utf8' });
    const lane = await readFile(path.join(out, 'lane-09.txt'), 'utf8');

    expect(lane).not.toMatch(/^error:/m);
    expect(lane).toMatch(/^ok {3}disposable reflink copy of the case folder$/m);
    expect(lane).toMatch(/^ok {3}same resultsVersion with an unrelated file in the case folder$/m);
    expect(lane).toMatch(/^ok {3}one changed original byte gives a new resultsVersion \(same inputRevision\)$/m);
    // the later bundles-only checks need the real sample's second HTML, and lanes other than 09 are skipped: exit 1
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^fixture case folder unchanged: true$/m);
    expect(await snapshot(caseDir)).toEqual(before);
  });
});
