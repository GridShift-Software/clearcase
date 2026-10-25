import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanModule } from '../../../deploy/probes/target.ts';
import { uploadModuleProblems } from '../../../deploy/native-alpha/pipeline.ts';
import { nativeRenderSdkBuild, NATIVE_SDK_WORKER_OUTPUTS } from '../../../scripts/native-render-sdk-build.ts';
import { applyNativeRenderSdkPolicy } from '../../../scripts/native-render-sdk-policy.ts';
import { fixture, bundle, FACTORY } from './harness.ts';
const fixtures: ReturnType<typeof fixture>[] = [];
const make = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const receipt = (root: string) => JSON.parse(readFileSync(path.join(root, '.local/native-render-sdk-build/ssr.json'), 'utf8'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('real SDK scoped build, NOT native evidence', () => {
 it('bundles the real factory; attests reached transformations and emitted chunks; identifies the unchanged checker host gap', async () => {
  const f = make(), chunks = await bundle(f.root), r = receipt(f.root);
  expect(r.evidence).toBe('SCOPED-BUNDLE-NOT-NATIVE');
  expect(r.environment).toBe('ssr');
  for (const name of ['common/Debug.js', 'cloudflare/utils.js']) {
   const input = readFileSync(path.join(f.root, 'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer', name), 'utf8');
   const expected = await applyNativeRenderSdkPolicy(name, input);
   expect(r.modules.find((m: { module: string }) => m.module === 'puppeteer/' + name)).toMatchObject({ inputSha256: expected.inputSha256, outputSha256: expected.outputSha256, steps: [{ inputSha256: expected.inputSha256, outputSha256: expected.outputSha256 }] });
  }
  for (const [module, outputSha256] of Object.entries(NATIVE_SDK_WORKER_OUTPUTS)) expect(r.modules.find((m: { module: string }) => m.module === module)).toMatchObject({ outputSha256 });
  expect(chunks).toHaveLength(1);
  for (const chunk of chunks) {
   expect(r.chunks.find((c: { file: string }) => c.file === chunk.fileName)).toMatchObject({ sha256: sha(chunk.code), bytes: new TextEncoder().encode(chunk.code).length });
   expect(chunk.code).not.toMatch(/globalThis\.Buffer\s*=|Error\.prepareStackTrace\s*=|process\.env|import\(["'](?:fs|path|debug)|NodeWebSocketTransport/);
   expect(chunk.code).toContain('native render SDK filesystem refused');
   expect(chunk.code).toContain('native render SDK file upload refused');
   expect(chunk.code).toContain('native render SDK generic connector refused');
   expect(chunk.code).toContain('[native render SDK event]');
   expect(chunk.code).toContain('native render SDK close refused');
   const facts = scanModule(chunk.code);
   expect(facts).toMatchObject({ syntaxErrors: [], specifiers: ['node:buffer'], requireCalls: 0, computedSpecifiers: 0, dynamicImports: 0 });
   // The parent now admits only this exact static Worker host under explicit compatibility policy.
   // This parser/closure result is not a workerd or real renderer acceptance claim.
   expect(uploadModuleProblems(facts, chunk.fileName, ['nodejs_compat'])).toEqual([]);
   expect(uploadModuleProblems(facts, chunk.fileName)).not.toEqual([]);
   expect(uploadModuleProblems(facts, chunk.fileName, [])).not.toEqual([]);
  }
 });
 it('fails if the production renderer is uncalled/unreached; clears prior receipts', async () => {
  const f = make(); await bundle(f.root);
  f.put('entry.ts', "export default {fetch(){return new Response('synthetic');}};");
  await expect(bundle(f.root)).rejects.toThrow(/missing required transform/);
  expect(existsSync(path.join(f.root, '.local/native-render-sdk-build/ssr.json'))).toBe(false);
 });
 it.each(['common/Debug.js', 'cloudflare/utils.js', 'cdp/Browser.js'])('rejects modified SDK bytes, even beyond the two policy modules: %s', async module => {
  const f = make(), file = path.join(f.root, 'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer', module);
  writeFileSync(file, readFileSync(file, 'utf8') + '\n');
  await expect(bundle(f.root)).rejects.toThrow(/ESM inventory bytes/);
 });
 it('refuses wrong package metadata even with the same ESM files', async () => {
  const f = make(), file = path.join(f.root, 'node_modules/@cloudflare/puppeteer/package.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"1.4.0"', '"1.4.1"'));
  await expect(bundle(f.root)).rejects.toThrow(/SDK package pin/);
 });
 it('does not accept an HTML policy marker as graph proof', async () => {
  const f = make(); f.put('entry.ts', "export default {fetch(){return new Response('<meta name=clearcase-sdk-policy content=clearcase.native-render-sdk-policy/1>');}};");
  await expect(bundle(f.root)).rejects.toThrow(/missing required transform/);
 });
 it('refuses pre-transformed/replayed SDK bytes', async () => {
  const f = make(), file = path.join(f.root, 'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/common/Debug.js');
  writeFileSync(file, (await applyNativeRenderSdkPolicy('common/Debug.js', readFileSync(file, 'utf8'))).code);
  await expect(bundle(f.root)).rejects.toThrow(/ESM inventory bytes/);
 });
 it.each(['@cloudflare/puppeteer', '@cloudflare/puppeteer/internal/common/Puppeteer.js', '@cloudflare/puppeteer/lib/esm/puppeteer/generated/version.js'])('rejects SDK construction outside the renderer: %s', async specifier => {
  const f = make(); f.put('entry.ts', `import * as sdk from '${specifier}'; export default sdk;`);
  await expect(bundle(f.root)).rejects.toThrow(/SDK construction edge/);
 });
 it('rejects an otherwise-valid SDK subpath from the renderer', async () => {
  const f = make(); f.put(FACTORY, "export * from '@cloudflare/puppeteer/internal/common/Puppeteer.js';");
  await expect(bundle(f.root)).rejects.toThrow(/SDK construction edge/);
 });
 it('refuses absolute SDK path bypasses', async () => {
  const f = make(); f.put(FACTORY, `export * from ${JSON.stringify(path.join(f.root, 'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/puppeteer-cloudflare.js'))};`);
  await expect(bundle(f.root)).rejects.toThrow(/SDK path bypass/);
 });
 it('refuses a symlinked package root', async () => {
  const f = make(), pkg = path.join(f.root, 'node_modules/@cloudflare/puppeteer');
  renameSync(pkg, pkg + '-other'); symlinkSync(pkg + '-other', pkg, 'dir');
  await expect(bundle(f.root)).rejects.toThrow(/symlink/);
 });
 it.each(['fs/promises', 'node:fs', 'path', 'node:buffer', 'net'])('never provides SDK adapters to application imports: %s', async specifier => {
  const f = make(); f.put('entry.ts', `import * as cap from '${specifier}'; export default cap;`);
  await expect(bundle(f.root)).rejects.toThrow(/non-SDK host capability/);
 });
 it('forces SDK bundling even when SSR requests externalization', async () => {
  const f = make();
  const chunks = await bundle(f.root, { config: { ssr: { external: ['@cloudflare/puppeteer'] } } });
  expect(chunks).toHaveLength(1);
  expect(receipt(f.root).modules.length).toBeGreaterThan(50);
 });
 it('refuses a bundler externalization bypass', async () => {
  const f = make();
  await expect(bundle(f.root, { config: { build: { ssr: path.join(f.root, 'entry.ts'), write: false, rolldownOptions: { external: ['@cloudflare/puppeteer'] } } } })).rejects.toThrow(/missing required transform|externalized SDK/);
 });
 it('refuses later plugin replacement of transformed policy output', async () => {
  const f = make();
  await expect(bundle(f.root, { plugins: [{ name: 'synthetic-late-bypass', enforce: 'post', transform(code, id) { if (id.endsWith('/common/Debug.js')) return code + '\n'; } }] })).rejects.toThrow(/missing actual transform/);
 });
 it('does not trust mutable bundler metadata as the authoritative policy hash', async () => {
  const f = make();
  await expect(bundle(f.root, { plugins: [{ name: 'synthetic-meta-bypass', enforce: 'post', transform(code, id) {
   if (id.endsWith('/common/Debug.js')) {
    const changed = code + '\n';
    const meta = this.getModuleInfo(id)?.meta.clearcaseNativeSdk;
    if (!meta) throw Error('missing synthetic test metadata');
    meta.outputSha256 = sha(changed);
    return changed;
   }
  } }] })).rejects.toThrow(/missing actual transform/);
 });
 it.each(['common/Debug.js', 'cloudflare/utils.js'])('refuses a missing individual policy module: %s', async module => {
  const f = make(), file = path.join(f.root, 'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer', module);
  await expect(bundle(f.root, { config: { build: { ssr: path.join(f.root, 'entry.ts'), write: false, rolldownOptions: { external: [file] } } } })).rejects.toThrow(/externalized SDK|missing required transform/);
 });
 it('refuses private adapter mutation by a later plugin', async () => {
  const f = make();
  await expect(bundle(f.root, { plugins: [{ name: 'synthetic-adapter-bypass', enforce: 'post', transform(code, id) { if (id.includes('clearcase-native-render:host-buffer')) return code + '\n'; } }] })).rejects.toThrow(/adapter output\/edge bypass/);
 });
 it('keeps the SDK out of the browser/client environment', async () => {
  const f = make();
  await expect(bundle(f.root, { config: { build: { lib: { entry: path.join(f.root, 'entry.ts'), formats: ['es'] }, write: false } } })).rejects.toThrow(/SDK outside server build/);
 });
 it('refuses private Buffer adapter imports from application modules', async () => {
  const f = make(); f.put('entry.ts', "import * as cap from 'clearcase-native-render:host-buffer'; export default cap;");
  await expect(bundle(f.root)).rejects.toThrow(/Buffer adapter edge/);
 });
 it('refuses an earlier plugin load/transform override', async () => {
  const f = make();
  await expect(bundle(f.root, { plugins: [{ name: 'synthetic-bypass', enforce: 'pre', transform: { order: 'pre', handler(code, id) { if (id.endsWith('/common/Debug.js')) return code + '\n'; } } }] })).rejects.toThrow(/input bytes\/replay|missing actual transform/);
 });
 it('keeps local untouched and gate SDK-free', async () => {
  expect(nativeRenderSdkBuild({ root: '/missing-root', target: 'local', profile: 'production' })).toBeUndefined();
  const f = make(); f.put('entry.ts', "export default {fetch(){return new Response('gate');}};");
  await expect(bundle(f.root, { profile: 'hosted-gate' })).resolves.toHaveLength(1);
  f.put('entry.ts', `import * as sdk from './${FACTORY}'; export default sdk;`);
  await expect(bundle(f.root, { profile: 'hosted-gate' })).rejects.toThrow(/SDK construction edge/);
 });
});
