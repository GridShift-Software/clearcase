import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';
import { scanModule } from '../../../deploy/probes/target.ts';
import { uploadModuleProblems } from '../../../deploy/native-alpha/pipeline.ts';
import { bundle, fixture } from './harness.ts';
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const installed = (module: string) => readFileSync(path.join('node_modules/@cloudflare/puppeteer/lib/esm/puppeteer', module), 'utf8');
const slice = (source: string, from: string, through: string) => {
 const start = source.indexOf(from), end = source.indexOf(through, start);
 if (start < 0 || end < 0) throw Error('missing original SDK site: ' + from);
 return source.slice(start, end + through.length);
};
// Server output is a Worker root for scanArtifact: the chunk is scanned exactly as Kit would emit it.
function artifact(root: string, server: string) {
 const out = path.join(root, '.local/scoped-artifact');
 for (const [name, text] of Object.entries({ '.svelte-kit/cloudflare/_worker.js': 'export default { fetch() {} };', '.svelte-kit/output/server/chunks/native-render.js': server })) {
  mkdirSync(path.dirname(path.join(out, name)), { recursive: true }); writeFileSync(path.join(out, name), text);
 }
 return scanArtifact({ root: out, profile: 'production' });
}

describe('real scoped factory/SDK bytes under the unchanged artifact and native module scanners, NOT native evidence', () => {
 it('the retained SDK chunk has no protected intrinsic write or unresolved global-object reach', async () => {
  const f = fixture(); fixtures.push(f);
  const [chunk] = await bundle(f.root);
  const scan = artifact(f.root, chunk!.code);
  expect(scan.errors).toEqual([]);
  expect(scan.files).toBe(2);
  expect(uploadModuleProblems(scanModule(chunk!.code), chunk!.fileName, ['nodejs_compat'])).toEqual([]);
 });
 it('the same scanner still refuses each original retained SDK site in that position', async () => {
  const f = fixture(); fixtures.push(f);
  const [chunk] = await bundle(f.root);
  const originals = [
   slice(installed('util/disposable.js'), "Symbol.dispose ??= Symbol('dispose');", "Symbol.asyncDispose ??= Symbol('asyncDispose');"),
   slice(installed('cdp/Binding.js'), 'export class Binding {', '//# sourceMappingURL=Binding.js.map').replace('export ', '').replace(/\n\/\/#.*$/, ''),
   slice(installed('cdp/utils.js'), 'export function addPageBinding(type, name, prefix) {', '\n}\n').replace('export ', ''),
   'const frame = { ' + slice(installed('cdp/Frame.js'), 'async removeExposedFunctionBinding(binding) {', '            ]);\n        }') + ' };',
  ];
  const errors = artifact(f.root, chunk!.code + originals.map(site => '\n{\n' + site + '\n}').join('')).errors.join('\n');
  for (const what of ['(Symbol.dispose)', '(Symbol.asyncDispose)', '(globalThis[name])', '(Object.assign(globalThis', '(globalThis[prefix + name])']) {
   expect(errors).toContain('.svelte-kit/output/server/chunks/native-render.js: unresolved global object access ' + what);
  }
 });
});
