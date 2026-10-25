import { afterEach, describe, expect, it } from 'vitest';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';
import { fixture, FACTORY } from './harness.ts';
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const SDK = '@cloudflare/puppeteer', VERSION = SDK + '/lib/esm/puppeteer/generated/version.js';
function project(renderer: string) {
 const f = fixture(); fixtures.push(f);
 f.put('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'preserve', moduleResolution: 'bundler' } }));
 f.put('deploy/client/hosted-files.json', JSON.stringify({ routes: 'src/hosted/routes', hooks: { server: 'src/hosted/hooks.server' }, profiles: { 'hosted-gate': { hooks: { server: 'src/hosted/hooks.server' } } } }));
 f.put('src/hosted/hooks.server.ts', "import '../lib/server/runtime/hosted/services';");
 f.put('src/lib/server/runtime/hosted/services.ts', "export * from '../../../viewer/hosted/native-render-check';");
 f.put('src/hosted/routes/+server.ts', 'export const GET = () => new Response();');
 f.put(FACTORY, renderer);
 return f;
}
describe.each(['production', 'hosted-gate'] as const)('SDK source boundary in %s', profile => {
 it('permits only the exact SDK root/version edges from the trusted renderer', () => {
  const f = project(`export * from '${SDK}'; export * from '${VERSION}';`);
  expect(checkHostedGraph({ root: f.root, profile }).errors).toEqual([]);
 });
 it.each([SDK, VERSION, SDK + '/internal/common/Puppeteer.js'])('refuses route construction from %s', specifier => {
  const f = project('export {};');
  f.put('src/hosted/routes/+server.ts', `export * from '${specifier}';`);
  expect(checkHostedGraph({ root: f.root, profile }).errors.join('\n')).toContain('native render SDK construction is restricted');
 });
 it('refuses deep SDK entry imports even from the renderer', () => {
  const f = project(`export * from '${SDK}/internal/common/Puppeteer.js';`);
  expect(checkHostedGraph({ root: f.root, profile }).errors.join('\n')).toContain('native render SDK construction is restricted');
 });
 it('does not let a trusted earlier edge bless a later route constructor', () => {
  const f = project(`export * from '${SDK}';`);
  f.put('src/hosted/routes/+server.ts', "export * from '../../lib/viewer/hosted/native-render-check';");
  expect(checkHostedGraph({ root: f.root, profile }).errors.join('\n')).toContain('native render construction is restricted to trusted hosted service composition');
 });
 it.each(['node:fs', 'fs/promises', 'path', 'node:buffer', 'an-unknown-package'])('keeps non-SDK capability/import %s forbidden', specifier => {
  const f = project(`export * from '${specifier}';`);
  expect(checkHostedGraph({ root: f.root, profile }).errors.length).toBeGreaterThan(0);
 });
});
