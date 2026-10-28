import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkHostedGraph } from '../../scripts/ci/hosted-imports';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function runeProject(body: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-14b-rune-'));
  roots.push(root);
  const files = {
    'deploy/client/hosted-files.json': JSON.stringify({ routes: 'src/hosted/routes', hooks: { server: 'src/hosted/hooks.server' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'preserve', paths: { '$lib/*': ['./src/lib/*'] } } }),
    'src/hosted/hooks.server.ts': 'export {};',
    'src/hosted/routes/+server.ts': "import { count } from '$lib/counter.svelte'; export const GET = () => new Response(String(count));",
    'src/lib/counter.svelte.ts': body,
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}

test('14b hosted wrappers can reach a rune module imported without its .ts suffix', async () => {
  const root = await runeProject('export const count = 1;');
  const result = checkHostedGraph({ root });
  expect(result.errors).toEqual([]);
  expect(result.files).toContain('src/lib/counter.svelte.ts');
});

test('14b resolving a rune module still traverses and rejects its forbidden imports', async () => {
  const root = await runeProject("import { readFileSync } from 'node:fs'; export const count = readFileSync('synthetic');");
  expect(checkHostedGraph({ root }).errors.join('\n')).toContain('forbidden capability node:fs');
});
