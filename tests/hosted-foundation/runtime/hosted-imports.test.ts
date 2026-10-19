import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project(hooks: string, files: Record<string, string> = {}, opts: { packages?: boolean } = {}) {
  const root = await mkdtemp(path.resolve('..', 'hosted-graph-')); roots.push(root);
  if (opts.packages) await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  const entries = {
    'deploy/client/hosted-files.json': JSON.stringify({ routes: 'src/hosted/routes', hooks: { server: 'src/hosted/hooks.server' }, profiles: { 'hosted-gate': { hooks: { server: 'src/hosted/gate.server' } } } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'preserve', paths: { '$lib/*': ['./src/lib/*'], '$bridge': ['./src/bridge.ts'] } } }),
    'src/hosted/hooks.server.ts': hooks,
    'src/hosted/routes/[...path]/+server.ts': 'export const GET = () => new Response(null, {status:503});',
    ...files,
  };
  for (const [name, text] of Object.entries(entries)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}
describe('resolved hosted import boundary', () => {
  it('accepts the actual selected hosted graph and excludes host-only tooling', () => {
    const result = checkHostedGraph({ root: process.cwd() });
    expect(result.errors).toEqual([]);
    expect(result.files).toContain('src/lib/server/runtime/hosted/hooks.server.ts');
    expect(result.files.some((f) => f.includes('tests/') || f.includes('memory'))).toBe(false);
  });
  it('erases type-only imports but follows aliases, re-exports and literal dynamic imports', async () => {
    const root = await project("import type { Version } from '$lib/local-case/store.server'; import '$bridge';", {
      'src/bridge.ts': "export * from './next';",
      'src/next.ts': "export const read = () => import('$lib/local-case/db.server');",
      'src/lib/local-case/db.server.ts': "import 'node:sqlite';",
      'src/lib/local-case/store.server.ts': "import 'node:fs'; export type Version = string;",
    });
    const result = checkHostedGraph({ root });
    expect(result.errors.join('\n')).toContain('hooks.server.ts -> src/bridge.ts -> src/next.ts -> src/lib/local-case/db.server.ts');
    expect(result.files).not.toContain('src/lib/local-case/store.server.ts');
  });
  it.each(['node:fs', 'fs/promises', 'node:sqlite', 'node:net', 'http', 'node:https', 'child_process', 'node:cluster', 'bun:sqlite'])('rejects reachable %s', async (specifier) => {
    const root = await project("export * from '$bridge';", { 'src/bridge.ts': `import '${specifier}';` });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain(specifier);
  });
  it.each(['process.env.KEY', 'process.cwd()', 'process.pid', 'Bun.file("x")', 'Bun.serve({})', 'globalThis["process"].exit(1)', 'import(name)', 'require(name)', 'eval("x")'])('fails closed for %s', async (source) => {
    const root = await project(source);
    expect(checkHostedGraph({ root }).errors.length).toBeGreaterThan(0);
  });
  it('expands glob edges before tree shaking and checks every selected route', async () => {
    const root = await project("import.meta.glob('./widgets/*.ts', {eager:true});", {
      'src/hosted/widgets/a.ts': 'export const x = 1;',
      'src/hosted/widgets/b.ts': "import 'node:fs';",
      'src/hosted/routes/hidden/+page.server.ts': "export const load = () => import('node:net');",
    });
    const result = checkHostedGraph({ root });
    expect(result.errors.join('\n')).toContain('src/hosted/widgets/b.ts');
    expect(result.errors.join('\n')).toContain('src/hosted/routes/hidden/+page.server.ts');
  });
  // Draft review finding 1: the homemade glob missed Vite's zero-directory `**/` and brace alternatives.
  it.each([
    ["import.meta.glob('./widgets/**/*.ts', {eager:true});", 'src/hosted/widgets/unsafe.ts'],
    ["import.meta.glob('./widgets/*.{ts,js}', {eager:true});", 'src/hosted/widgets/unsafe.ts'],
    ["import.meta.glob(['./widgets/**/*.ts', '!./widgets/safe.ts']);", 'src/hosted/widgets/unsafe.ts'],
  ])('fails closed on every Vite glob form: %s', async (hooks, unsafe) => {
    const root = await project(hooks, { 'src/hosted/widgets/safe.ts': 'export const x = 1;', 'src/hosted/widgets/unsafe.ts': "import 'node:fs';" });
    expect(checkHostedGraph({ root }).errors.join('\n')).toMatch(new RegExp(`${unsafe.replaceAll('/', '\\/').replaceAll('.', '\\.')}|unsupported glob`));
  });
  it('fails closed on glob options that move its base', async () => {
    const root = await project("import.meta.glob('./*.ts', { base: '../lib' });", { 'src/lib/unsafe.ts': "import 'node:fs';" });
    expect(checkHostedGraph({ root }).errors.join('\n')).toMatch(/unsafe\.ts|unsupported glob/);
  });
  it('stops at the allowlisted framework packages and refuses any other package', async () => {
    const root = await project("import { error } from '@sveltejs/kit'; import { Type } from 'typebox'; export { error, Type }; import '$bridge';", { 'src/bridge.ts': "export { unzipSync } from 'fflate';" }, { packages: true });
    const errors = checkHostedGraph({ root }).errors.join('\n');
    expect(errors).toContain('src/bridge.ts: package outside the hosted allowlist fflate');
    expect(errors).not.toMatch(/@sveltejs\/kit|typebox/);
  });
  it('names only the Kit app modules and the Workers env module, nothing else of their schemes', async () => {
    const ok = await project("import { env } from 'cloudflare:workers'; import { page } from '$app/state'; import { browser } from '$app/env'; export { env, page, browser };", {}, { packages: true });
    expect(checkHostedGraph({ root: ok }).errors).toEqual([]);
    const bad = await project("import 'cloudflare:sockets'; import { read } from '$app/server'; export { read };", {}, { packages: true });
    const errors = checkHostedGraph({ root: bad }).errors.join('\n');
    expect(errors).toContain('forbidden capability cloudflare:sockets');
    expect(errors).toMatch(/hooks\.server\.ts: (?:unresolved|package outside the hosted allowlist) \$app\/server/);
  });
  it('refuses the memory doubles in every profile and the gate doubles outside the hosted-gate profile', async () => {
    const files = {
      'src/hosted/gate.server.ts': "export * from '$lib/server/runtime/hosted/gate/services';",
      'src/lib/server/runtime/hosted/gate/services.ts': 'export const gate = 1;',
      'src/lib/server/runtime/memory.ts': 'export const memory = 1;',
      'src/hosted/routes/probe/+server.ts': "export { memory } from '$lib/server/runtime/memory';",
    };
    const production = checkHostedGraph({ root: await project("export * from '$lib/server/runtime/hosted/gate/services';", files) }).errors.join('\n');
    expect(production).toContain('src/lib/server/runtime/hosted/gate/services.ts: forbidden test double in the production graph');
    expect(production).toContain('src/lib/server/runtime/memory.ts: forbidden test double in the production graph');
    const gate = checkHostedGraph({ root: await project('export {};', files), profile: 'hosted-gate' }).errors.join('\n');
    expect(gate).not.toContain('hosted/gate/services.ts');
    expect(gate).toContain('src/lib/server/runtime/memory.ts: forbidden test double in the hosted-gate graph');
  });
  it('refuses any module of the local route tree, the folder browser among it', async () => {
    const root = await project("export * from '$bridge';", { 'src/bridge.ts': "export { GET } from './routes/api/browse/+server.ts';", 'src/routes/api/browse/+server.ts': 'export const GET = () => new Response();' });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain('src/routes/api/browse/+server.ts: forbidden local route module');
  });
  it('compiles Svelte components it reaches by $lib or relative paths and walks their script blocks', async () => {
    const root = await project('export {};', {
      'src/hosted/routes/probe/+page.svelte': "<script lang=\"ts\">import Panel from '$lib/components/Panel.svelte';</script><Panel />",
      'src/lib/components/Panel.svelte': "<script lang=\"ts\">import Inner from './Inner.svelte';</script><Inner />",
      'src/lib/components/Inner.svelte': "<script lang=\"ts\">import { readFileSync } from 'node:fs'; const t = readFileSync('x', 'utf8');</script><p>{t}</p>",
    }, { packages: true });
    expect(checkHostedGraph({ root }).errors.join('\n')).toContain('src/lib/components/Panel.svelte -> src/lib/components/Inner.svelte: forbidden capability node:fs');
  });
  it('allows safe crypto and fails unresolved imports rather than skipping them', async () => {
    const root = await project("import 'node:crypto'; import './not-there';");
    const result = checkHostedGraph({ root });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('unresolved ./not-there');
  });
});
