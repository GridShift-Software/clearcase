import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function artifact(server: string, worker = 'export default { fetch() {} };') {
  const root = await mkdtemp(path.resolve('..', 'hosted-artifact-')); roots.push(root);
  for (const [name, text] of Object.entries({ '.svelte-kit/cloudflare/_worker.js': worker, '.svelte-kit/output/server/chunks/app.js': server })) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text);
  }
  return root;
}

describe('emitted hosted artifact scan', () => {
  it('passes a clean production artifact and Kit\'s own guarded getBuiltinModule line', async () => {
    const root = await artifact('var fs = globalThis.process?.getBuiltinModule?.("node:fs");\nexport const x = "bun: 1.4.2";');
    expect(scanArtifact({ root, profile: 'production' }).errors).toEqual([]);
  });
  it.each([
    ['import { readFileSync } from "node:fs";', 'imports node:fs'],
    ['export * from "fs/promises";', 'imports fs/promises'],
    ['const db = await import("bun:sqlite");', 'imports bun:sqlite'],
    ['const s = require(\'node:sqlite\');', 'imports node:sqlite'],
    ['import "node:child_process";', 'imports node:child_process'],
    ['import Database from "better-sqlite3";', 'imports better-sqlite3'],
  ])('refuses %s', async (source, error) => {
    const root = await artifact(source);
    expect(scanArtifact({ root, profile: 'production' }).errors.join('\n')).toContain(`.svelte-kit/output/server/chunks/app.js: ${error}`);
  });
  it.each([
    ["process.on('SIGTERM', () => {});", 'uses process.on'],
    ['const home = process.env.HOME;', 'uses process.env'],
    ['globalThis.process.exit(1);', 'uses process.exit'],
    ['const f = Bun.file("x");', 'uses Bun.file'],
  ])('refuses %s', async (source, error) => {
    const root = await artifact(source);
    expect(scanArtifact({ root, profile: 'production' }).errors.join('\n')).toContain(`.svelte-kit/output/server/chunks/app.js: ${error}`);
  });
  it('allows the framework\'s guarded process probes and a property named process', async () => {
    const root = await artifact('const c = globalThis.process?.cwd?.(); const w = typeof process==`object`&&process.versions?.node!==void 0; const o = { process: 1 }; o.process.x; const b = Bun_ok;');
    expect(scanArtifact({ root, profile: 'production' }).errors).toEqual([]);
  });
  it('refuses the memory doubles in every profile', async () => {
    const root = await artifact('const m = { buildId: "memory-contract-diagnostic" }; export const TEST_DOUBLE = "clearcase-test-double:hosted-gate";');
    for (const profile of ['production', 'hosted-gate'] as const) expect(scanArtifact({ root, profile }).errors.join('\n')).toContain('contains the memory test double');
  });
  it('refuses the hosted-gate doubles in a production artifact and requires them in a hosted-gate one', async () => {
    const gate = await artifact('export const TEST_DOUBLE = "clearcase-test-double:hosted-gate";');
    expect(scanArtifact({ root: gate, profile: 'production' }).errors.join('\n')).toContain('contains the hosted-gate test doubles in a production artifact');
    expect(scanArtifact({ root: gate, profile: 'hosted-gate' }).errors).toEqual([]);
    const plain = await artifact('export const x = 1;');
    expect(scanArtifact({ root: plain, profile: 'hosted-gate' }).errors.join('\n')).toContain('without its test doubles');
  });
});
