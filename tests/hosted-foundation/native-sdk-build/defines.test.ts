import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '@sveltejs/kit/vite';
import type { Plugin } from 'vite';
const mocks = vi.hoisted(() => ({ kit: vi.fn((_config: unknown) => [{ name: 'synthetic-kit' }]) }));
vi.mock('@sveltejs/kit/vite', () => ({ sveltekit: mocks.kit }));
vi.mock('@sveltejs/adapter-cloudflare', () => ({ default: () => ({ name: 'synthetic-cloudflare' }) }));
vi.mock('@sveltejs/adapter-node', () => ({ default: () => ({ name: 'synthetic-node' }) }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });
async function config(target: 'local' | 'hosted', profile?: string, command: 'serve' | 'build' = 'build') {
 vi.stubEnv('CLEARCASE_TARGET', target); vi.stubEnv('CLEARCASE_HOSTED_PROFILE', profile);
 vi.stubEnv('__CLEARCASE_PDF_ASSETS__', 'UNTRUSTED_ENV_CLAIM');
 vi.stubEnv('CLEARCASE_PDF_ASSETS', 'UNTRUSTED_ENV_CLAIM');
 const { default: create } = await import('../../../vite.config.ts');
 if (typeof create !== 'function') throw Error('expected config factory');
 const result = await create({ command, mode: 'production', isPreview: false });
 const cleanup = result.plugins?.at(-1) as Plugin | undefined;
 if (cleanup?.name === 'clearcase-hosted-static-input') cleanups.push(async () => {
  const hook = cleanup.buildApp;
  if (!hook || typeof hook === 'function') throw Error('expected ordered cleanup');
  await Reflect.apply(hook.handler, undefined, []);
 });
 return result;
}
describe('trusted PDF inventory define; config only, not an app build', () => {
 it('defines the actual 192 copied inputs for production, with no env claim/public manifest; preserves cleanup', async () => {
  const c = await config('hosted');
  const encoded = c.define?.__CLEARCASE_PDF_ASSETS__;
  expect(typeof encoded).toBe('string');
  const pins = JSON.parse(String(encoded));
  const kit = mocks.kit.mock.calls[0]![0] as Config;
  const assets = kit.files?.assets;
  expect(typeof assets).toBe('string');
  expect(pins).toMatchObject({ schema: 'clearcase.hosted-pdf-assets/1', pdfjsVersion: '6.4.299' });
  expect(pins.files).toHaveLength(192);
  for (const file of pins.files) {
   const bytes = readFileSync(path.join(assets!, file.path));
   expect(bytes.length).toBe(file.bytes);
   expect('sha256:' + createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  }
  expect(encoded).not.toContain('UNTRUSTED_ENV_CLAIM');
  expect(existsSync(path.join(assets!, 'pdfjs/manifest.json'))).toBe(false);
  await cleanups.pop()!();
  expect(existsSync(assets!)).toBe(false);
 });
 it.each([['local', undefined, 'build'], ['hosted', 'hosted-gate', 'build'], ['hosted', undefined, 'serve']] as const)('leaves pins null for %s %s %s', async (target, profile, command) => {
  const c = await config(target, profile, command);
  expect(c.define?.__CLEARCASE_PDF_ASSETS__).toBe('null');
 });
});
