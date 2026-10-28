import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareHostedStaticInput, type HostedStaticInput } from '../../../scripts/hosted-static-input.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
let scratch: string, root: string;
let inputs: HostedStaticInput[];
const put = (path: string, bytes: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const prepare = () => { const input = prepareHostedStaticInput(root); inputs.push(input); return input; };
const leftovers = () => existsSync(join(root, '.local')) ? readdirSync(join(root, '.local')).filter(n => n.startsWith('hosted-static-input-')) : [];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cc-static-input-')); root = join(scratch, 'checkout'); inputs = [];
  mkdirSync(root);
  cpSync(join(repo, 'static'), join(root, 'static'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(root, 'package.json'));
  const pkg = join(root, 'node_modules/pdfjs-dist'); mkdirSync(pkg, { recursive: true });
  for (const path of ['package.json', 'LICENSE', 'build', 'standard_fonts', 'cmaps', 'iccs']) cpSync(join(repo, 'node_modules/pdfjs-dist', path), join(pkg, path), { recursive: true });
  const reader = 'src/lib/viewer/hosted/static/pdf-reader.mjs'; mkdirSync(dirname(join(root, reader)), { recursive: true }); cpSync(join(repo, reader), join(root, reader));
});
afterEach(() => { for (const input of inputs) input.dispose(); rmSync(scratch, { recursive: true, force: true }); });

describe('exclusive hosted Kit static input', () => {
  it('combines trusted static with the real pinned inventory, without mirroring other roots or touching outputs', () => {
    for (const path of ['RAWS/private.pdf', '.local/secret', 'case/original.pdf', 'build/keep', '.svelte-kit/output/keep']) put(join(root, path), 'private sentinel');
    const input = prepare();
    expect(input.assets).toMatch(/\/\.local\/hosted-static-input-[^/]+$/);
    expect(readdirSync(input.assets).sort()).toEqual(['favicon.svg', 'pdfjs']);
    expect(readFileSync(join(input.assets, 'favicon.svg'))).toEqual(readFileSync(join(root, 'static/favicon.svg')));
    expect(input.inventory.files).toHaveLength(192);
    for (const file of input.inventory.files) expect(readFileSync(join(input.assets, file.path)).length).toBe(file.bytes);
    input.dispose(); input.dispose();
    expect(existsSync(input.assets)).toBe(false);
    for (const path of ['RAWS/private.pdf', '.local/secret', 'case/original.pdf', 'build/keep', '.svelte-kit/output/keep']) expect(readFileSync(join(root, path), 'utf8')).toBe('private sentinel');
    expect(existsSync(join(root, 'static/pdfjs'))).toBe(false);
  });
  it('allocates independent inputs and disposes only its own tree', () => {
    const first = prepare(), second = prepare();
    first.dispose(); expect(existsSync(second.assets)).toBe(true);
    expect(first.assets).not.toBe(second.assets);
  });
  it.each(['.local', 'static'])('refuses a symlinked %s root without changing its target', name => {
    const outside = join(scratch, 'outside'); mkdirSync(outside); put(join(outside, 'keep'), 'keep');
    rmSync(join(root, name), { recursive: true, force: true }); symlinkSync(outside, join(root, name));
    expect(prepare).toThrow(/real directory/); expect(readdirSync(outside)).toEqual(['keep']);
  });
  it.each(['static', '.local'])('refuses a non-directory %s root', name => {
    rmSync(join(root, name), { recursive: true, force: true }); put(join(root, name), 'keep');
    expect(prepare).toThrow(/real directory/);
    expect(readFileSync(join(root, name), 'utf8')).toBe('keep');
  });
  it('refuses a symlinked checkout ancestor', () => {
    const alias = join(scratch, 'alias'); symlinkSync(root, alias);
    expect(() => prepareHostedStaticInput(alias)).toThrow(/real directory/);
    expect(leftovers()).toEqual([]);
  });
  it.each(['file', 'directory', 'broken'])('refuses %s symlinks inside static and cleans the fresh tree', kind => {
    symlinkSync(kind === 'file' ? join(root, 'package.json') : kind === 'directory' ? join(root, 'node_modules') : join(root, 'missing'), join(root, 'static/link'));
    expect(prepare).toThrow(/symlink/); expect(leftovers()).toEqual([]);
  });
  it('refuses hard-linked files', () => {
    linkSync(join(root, 'package.json'), join(root, 'static/hardlink'));
    expect(prepare).toThrow(/single-link regular/); expect(leftovers()).toEqual([]);
  });
  it('refuses nonregular files without blocking', () => {
    expect(spawnSync('mkfifo', [join(root, 'static/fifo')]).status).toBe(0);
    expect(prepare).toThrow(/regular/); expect(leftovers()).toEqual([]);
  });
  it.each(['.local', 'RAWS', 'secrets', 'case', 'pdfjs', 'bad%2fpath', 'bad\\path', 'bad?path'])('refuses unsafe static entry %s', name => {
    put(join(root, 'static', name, 'keep'), 'keep');
    expect(prepare).toThrow(/unsafe static path/); expect(leftovers()).toEqual([]);
    expect(readFileSync(join(root, 'static', name, 'keep'), 'utf8')).toBe('keep');
  });
  it('cleans after failed PDF preparation, retaining existing local and output trees', () => {
    put(join(root, '.local/hosted-static-input-existing/keep'), 'keep');
    put(join(root, 'build/pdfjs/keep'), 'keep');
    put(join(root, 'src/lib/viewer/hosted/static/pdf-reader.mjs'), 'changed');
    expect(prepare).toThrow(/reviewed PDF reader/);
    expect(leftovers()).toEqual(['hosted-static-input-existing']);
    expect(readFileSync(join(root, 'build/pdfjs/keep'), 'utf8')).toBe('keep');
  });
  it.each([
    ['', 0],
    ['throw new Error("synthetic late build failure");', 1],
    ['process.emit("SIGINT");', 130],
    ['process.emit("SIGTERM");', 143],
  ] as const)('removes the input on process completion %j', (ending, status) => {
    const script = `import { prepareHostedStaticInput } from ${JSON.stringify(join(repo, 'scripts/hosted-static-input.ts'))}; console.log(prepareHostedStaticInput(process.argv[1]).assets); ${ending}`;
    const child = spawnSync('bun', ['-e', script, root], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(status);
    expect(existsSync(child.stdout.trim())).toBe(false); expect(leftovers()).toEqual([]);
  });
});
