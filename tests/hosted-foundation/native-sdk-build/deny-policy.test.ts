import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { nativeRenderSdkBuild } from '../../../scripts/native-render-sdk-build.ts';
import { fixture } from './harness.ts';
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function call(hook: unknown, args: unknown[]) {
 if (typeof hook === 'function') return Reflect.apply(hook, {}, args);
 if (hook && typeof hook === 'object' && 'handler' in hook && typeof hook.handler === 'function') return Reflect.apply(hook.handler, {}, args);
 throw Error('expected build hook');
}
async function policy() {
 const f = fixture(); fixtures.push(f);
 const plugin = nativeRenderSdkBuild({ root: f.root, target: 'hosted', profile: 'production' });
 if (!plugin) throw Error('expected hosted plugin');
 await call(plugin.buildStart, []);
 const id = (module: string) => path.join(f.root, 'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer', module);
 const original = (module: string) => readFileSync(id(module), 'utf8');
 const transform = async (module: string) => (await call(plugin.transform, [original(module), id(module)])).code as string;
 return { f, plugin, id, original, transform };
}
function declaration(source: string, name: string) {
 const sf = ts.createSourceFile('sdk.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
 let code = '';
 const visit = (node: ts.Node) => {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(sf) === name) code = node.getText(sf).replace(/^export /, '');
  ts.forEachChild(node, visit);
 };
 visit(sf);
 if (!code) throw Error('missing declaration: ' + name);
 return code;
}
describe('deny-only restrictions, inert source execution (not native evidence)', () => {
 it('filesystem APIs throw, never fake a successful import/write', async () => {
  const p = await policy(), code = await p.transform('common/util.js');
  const api = new Function('let fs = null; ' + declaration(code, 'importFSPromises') + '; return importFSPromises;')();
  await expect(api()).rejects.toThrow('native render SDK filesystem refused');
  await expect(api()).rejects.toThrow('native render SDK filesystem refused');
 });
 it.each([{ files: [] }, { files: ['synthetic.pdf'] }])('file upload with $files always throws', async ({ files }) => {
  const p = await policy(), code = await p.transform('cdp/ElementHandle.js');
  const upload = new Function('assert', 'return ({' + declaration(code, 'uploadFile') + '}).uploadFile;')((v: boolean) => { if (!v) throw Error('assertion refused'); });
  await expect(upload.apply({ evaluate: async () => true }, files)).rejects.toThrow('native render SDK file upload refused');
 });
 it('both generic connector paths throw before fetching/constructing a network transport', async () => {
  const p = await policy();
  const connector = new Function((await p.transform('common/BrowserConnector.js')).replace('export ', '') + '; return _connectToBrowser;')();
  await expect(connector({ browserURL: 'https://synthetic.invalid' })).rejects.toThrow('generic connector refused');
  const Transport = new Function((await p.transform('common/BrowserWebSocketTransport.js')).replace('export ', '') + '; return BrowserWebSocketTransport;')();
  expect(() => new Transport()).toThrow('generic transport refused');
  await expect(Transport.create()).rejects.toThrow('generic transport refused');
 });
 it('rejects wrong source, replay, query and foreign SDK paths at the actual transform hook', async () => {
  const p = await policy(), module = 'common/Debug.js', source = p.original(module), id = p.id(module);
  await expect(call(p.plugin.transform, [source + '\n', id])).rejects.toThrow(/input bytes\/replay/);
  const output = await p.transform(module);
  await expect(call(p.plugin.transform, [output, id])).rejects.toThrow(/input bytes\/replay/);
  await expect(call(p.plugin.transform, [source, id])).rejects.toThrow(/transform replay/);
  await expect(call(p.plugin.transform, [source, id + '?raw'])).rejects.toThrow(/wrong SDK root\/path/);
  await expect(call(p.plugin.transform, [source, '/foreign/node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/common/Debug.js'])).rejects.toThrow(/wrong SDK root\/path/);
 });
});
describe('host disposal symbols and denied page bindings, inert source execution (not native evidence)', () => {
 const evaluate = (code: string, names: string, host: unknown = Symbol) => new Function('Symbol', code.replace(/^export /gm, '') + '; return {' + names + '};')(host);
 it('reads the actual host disposal symbols and never writes the Symbol intrinsic', async () => {
  const p = await policy(), original = p.original('util/disposable.js'), code = await p.transform('util/disposable.js');
  const absent = () => {
   const writes: string[] = [];
   const host = Object.defineProperties(function SyntheticSymbol(description?: string) { return Symbol(description); }, Object.fromEntries(['dispose', 'asyncDispose'].map(key => [key, { get: () => undefined, set: () => { writes.push(key); } }])));
   return { host, writes };
  };
  const before = absent();
  evaluate(original, 'disposeSymbol', before.host);
  expect(before.writes).toEqual(['dispose', 'asyncDispose']);
  const after = absent(), missing = evaluate(code, 'disposeSymbol, asyncDisposeSymbol', after.host);
  expect(after.writes).toEqual([]);
  expect(missing).toEqual({ disposeSymbol: undefined, asyncDisposeSymbol: undefined });
  const actual = evaluate(code, 'disposeSymbol, asyncDisposeSymbol, DisposableStack');
  expect([actual.disposeSymbol, actual.asyncDisposeSymbol]).toEqual([Symbol.dispose, Symbol.asyncDispose]);
  const disposed: string[] = [], stack = new actual.DisposableStack();
  stack.use({ [Symbol.dispose]: () => disposed.push('host symbol') });
  stack.dispose();
  expect(disposed).toEqual(['host symbol']);
 });
 it('Binding keeps its name and init source, and run always throws before evaluating in any context', async () => {
  const p = await policy(), Binding = evaluate((await p.transform('cdp/Binding.js')).replace(/^import .*$/gm, ''), 'Binding').Binding;
  const binding = new Binding('synthetic', () => 'never', 'synthetic init'), calls: string[] = [];
  const context = { evaluate: async () => { calls.push('evaluate'); }, evaluateHandle: async () => { calls.push('evaluateHandle'); } };
  expect([binding.name, binding.initSource]).toEqual(['synthetic', 'synthetic init']);
  await expect(binding.run(context, 1, [], true)).rejects.toThrow('native render SDK page binding refused');
  await expect(binding.run(context, 2, [{}], false)).rejects.toThrow('native render SDK page binding refused');
  expect(calls).toEqual([]);
 });
 it('the page binding installer and its init string throw in the Worker', async () => {
  const p = await policy(), code = await p.transform('cdp/utils.js');
  const install = new Function(declaration(code, 'addPageBinding') + '; return addPageBinding;')();
  const init = new Function('evaluationString', declaration(code, 'pageBindingInitString') + '; return pageBindingInitString;')(() => 'never');
  expect(() => install('internal', 'synthetic', 'puppeteer_')).toThrow('native render SDK page binding refused');
  expect(() => init('exposedFun', 'synthetic')).toThrow('native render SDK page binding refused');
 });
 it('frame exposed-function bindings and execution-context bindings refuse before any CDP command', async () => {
  const p = await policy(), frame = await p.transform('cdp/Frame.js'), context = await p.transform('cdp/ExecutionContext.js'), sent: string[] = [];
  const client = { send: async (method: string) => { sent.push(method); } };
  for (const name of ['addExposedFunctionBinding', 'removeExposedFunctionBinding']) {
   const method = new Function('return ({' + declaration(frame, name) + '})')()[name];
   await expect(method.call({ _frameManager: { mainFrame: () => null }, _hasStartedLoading: true, evaluate: async () => {} }, { name: 'synthetic' })).rejects.toThrow('native render SDK page binding refused');
  }
  const Context = new Function('client', 'return class { #client = client; #bindings = new Map(); #mutex = { acquire: async () => ({ [Symbol.dispose]() {} }) }; #name; #id = 1; ' + declaration(context, '#addBinding') + ' add(binding) { return this.#addBinding(binding); } evaluate() { client.send("evaluate"); } };')(client);
  await expect(new Context().add({ name: '__ariaQuerySelector' })).rejects.toThrow('native render SDK page binding refused');
  expect(sent).toEqual([]);
 });
});
