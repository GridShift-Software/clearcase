import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project(hooks: string, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.resolve('..', 'hosted-graph-')); roots.push(root);
  const entries = {
    'deploy/client/hosted-files.json': JSON.stringify({ routes: 'src/hosted/routes', hooks: { server: 'src/hosted/hooks.server' } }),
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
  it('allows safe crypto and fails unresolved imports rather than skipping them', async () => {
    const root = await project("import 'node:crypto'; import './not-there';");
    const result = checkHostedGraph({ root });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('unresolved ./not-there');
  });
});
