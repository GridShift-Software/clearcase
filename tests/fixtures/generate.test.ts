import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Value } from 'typebox/value';
import { afterEach, expect, it } from 'vitest';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import { KNOWN_KEYS } from '../../src/lib/case-package/registry.ts';
import { Manifest } from '../../src/lib/case-package/schema.ts';

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clearcase-corpus-'));
  temporary.push(dir);
  return dir;
}
const generate = (...args: string[]) => spawnSync(process.execPath, [path.resolve('scripts/fixtures/generate.ts'), ...args], { encoding: 'utf8', timeout: 20_000 });
const resultsVersion = async (out: string) => Value.Parse(Manifest, JSON.parse(await readFile(path.join(out, 'pkg/manifest.json'), 'utf8'))).resultsVersion;

async function fingerprints(root: string) {
  const paths = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => path.relative(root, path.join(entry.parentPath, entry.name))).sort();
  return Promise.all(paths.map(async file => ({ file, sha256: sha256Hex(await readFile(path.join(root, file))) })));
}

async function validate(out: string, report: string) {
  const result = spawnSync(process.execPath, [path.resolve('scripts/case-package/cli.ts'), 'validate',
    '--package', path.join(out, 'pkg'), '--case-folder', path.join(out, 'case'),
    '--report', report, '--activation-check'], { encoding: 'utf8', timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  const validation: unknown = JSON.parse(await readFile(report, 'utf8'));
  expect(validation).toMatchObject({ verdict: 'accept', errorFingerprints: [], warningFingerprints: [], activation: { ok: true, reasons: [], newWarnings: [] } });
}

it('generates every named dataset, validates without warnings, and reproduces every byte for the same seed', async () => {
  const root = await scratch();
  const a = path.join(root, 'a'), b = path.join(root, 'b'), other = path.join(root, 'other');
  for (const out of [a, b]) {
    const result = generate('--out', out, '--seed', 'corpus-proof', '--documents', '32', '--profile', 'small');
    expect(result.status, result.stderr).toBe(0);
    await validate(out, path.join(root, path.basename(out) + '-validation.json'));
  }
  expect(await fingerprints(a)).toEqual(await fingerprints(b));
  expect((await readdir(path.join(a, 'pkg/datasets'))).sort()).toEqual([...KNOWN_KEYS.keys()].map(key => `${key}.json`).sort());
  const chronology: unknown = JSON.parse(await readFile(path.join(a, 'pkg/datasets/chronology.json'), 'utf8'));
  expect(chronology).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ ref: 'SY-0032' })]) });
  for (const file of await fingerprints(path.join(a, 'pkg'))) {
    expect(await readFile(path.join(a, 'pkg', file.file), 'utf8')).not.toMatch(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
  }
  const changed = generate('--out', other, '--seed', 'another-seed', '--documents', '32');
  expect(changed.status, changed.stderr).toBe(0);
  expect(await resultsVersion(other)).not.toBe(await resultsVersion(a));
});

it.each([1, 6])('keeps metadata and references valid for %i documents', async documents => {
  const root = await scratch();
  const out = path.join(root, 'corpus');
  const result = generate('--out', out, '--documents', String(documents));
  expect(result.status, result.stderr).toBe(0);
  await validate(out, path.join(root, 'validation.json'));
});

it('refuses existing outputs, checkout destinations and invalid options before generating files', async () => {
  const root = await scratch();
  const existing = path.join(root, 'existing');
  await mkdir(existing);
  await writeFile(path.join(existing, 'sentinel'), 'preserve me');
  expect(generate('--out', existing).status).toBe(1);
  expect(await readdir(existing)).toEqual(['sentinel']);
  expect(await readFile(path.join(existing, 'sentinel'), 'utf8')).toBe('preserve me');
  const file = path.join(root, 'file');
  await writeFile(file, 'preserve file');
  expect(generate('--out', file).status).toBe(1);
  expect(await readFile(file, 'utf8')).toBe('preserve file');
  const link = path.join(root, 'checkout');
  await symlink(path.resolve('.'), link, 'dir');
  expect(generate('--out', path.join(link, 'forbidden-output')).stderr).toContain('outside the checkout');
  expect(generate('--out', path.resolve('forbidden-output')).stderr).toContain('outside the checkout');
  expect(generate().stderr).toContain('--out is required');
  for (const args of [['--documents', '0'], ['--documents', '-1'], ['--documents', '1.5'], ['--documents', 'not-a-number'], ['--profile', 'unknown']]) {
    expect(generate('--out', path.join(root, 'invalid'), ...args).status).toBe(1);
  }
  expect(await readdir(root)).not.toContain('invalid');
});
