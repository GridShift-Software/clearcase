// Build-only, scoped to the reviewed official SDK. Never import this file into the Worker.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { applyNativeRenderSdkPolicy, NATIVE_RENDER_SDK_POLICY } from './native-render-sdk-policy.ts';
import type { HostedProfile } from './ci/hosted-imports.ts';

import { NATIVE_SDK_BUILD_SCHEMA, NATIVE_SDK_INPUT_PINS, NATIVE_SDK_WORKER_OUTPUTS, NATIVE_SDK_HOST_SYMBOLS, NATIVE_SDK_BUFFER_SOURCE as BUFFER_SOURCE, NATIVE_SDK_DEBUG_SOURCE as DEBUG_SOURCE } from '../src/lib/viewer/hosted/sdk-build-contract.ts';
export { NATIVE_SDK_BUILD_SCHEMA, NATIVE_SDK_INPUT_PINS, NATIVE_SDK_WORKER_OUTPUTS } from '../src/lib/viewer/hosted/sdk-build-contract.ts';
const SDK = '@cloudflare/puppeteer';
const FACTORY = 'src/lib/viewer/hosted/native-render-check.ts';
const VERSION = SDK + '/lib/esm/puppeteer/generated/version.js';
const BUFFER = '\0clearcase-native-render:host-buffer';
const DEBUG = '\0clearcase-native-render:deny-node-debug';
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const slash = (s: string) => s.replaceAll(path.sep, '/');
function refused(why: string): never { throw Error('native render SDK build refused: ' + why); }

// The entire official ESM JS inventory (including third_party/rxjs) and package metadata from the frozen install.
// Individual reached inputs are compared AGAIN with this captured inventory, never accepted by suffix alone.
const edits = {
 'puppeteer/cloudflare/PuppeteerWorkers.js': [
  ["import './globalPatcher.js';", '// Global patching denied; Buffer is imported lexically by its consumers.'],
 ],
 'puppeteer/environment.js': [
  ["export const isNode = !!(typeof process !== 'undefined' && process.version);", 'export const isNode = false;'],
 ],
 'puppeteer/common/util.js': [
  ["fs = await import('fs/promises');", "throw new Error('native render SDK filesystem refused');"],
  ["    const original = Error.prepareStackTrace;\n    Error.prepareStackTrace = (_, stack) => {\n        // First element is the function.\n        // Second element is the caller of this function.\n        // Third element is the caller of the caller of this function\n        // which is precisely what we want.\n        return stack[2];\n    };\n    const site = new Error().stack;\n    Error.prepareStackTrace = original;", "    // No V8 intrinsic mutation or captured stack: diagnostic source label only.\n    const site = 'native-render';"],
 ],
 'puppeteer/cdp/ElementHandle.js': [
  ["path = await import('path');", "throw new Error('native render SDK file upload refused');"],
 ],
 'puppeteer/api/Page.js': [
  ["import { EventEmitter, }", "import { Buffer } from 'clearcase-native-render:host-buffer';\nimport { EventEmitter, }"],
 ],
 'puppeteer/cdp/HTTPResponse.js': [
  ["import { HTTPResponse }", "import { Buffer } from 'clearcase-native-render:host-buffer';\nimport { HTTPResponse }"],
 ],
 // Host disposal symbols only. The factory refuses a host without them; the Symbol intrinsic is never written.
 'puppeteer/util/disposable.js': [
  ["Symbol.dispose ??= Symbol('dispose');\nSymbol.asyncDispose ??= Symbol('asyncDispose');\n", ''],
 ],
 // Page bindings and exposed functions are unsupported: each refuses in the Worker before any CDP command or
 // browser-serialized global callback. A three-part edit replaces [from, until) and both markers must be unique.
 'puppeteer/cdp/Binding.js': [
  ['    async run(context, id, args, isTrivial) {', '\n}\n//# sourceMappingURL', "    async run() {\n        throw new Error('native render SDK page binding refused');\n    }"],
 ],
 'puppeteer/cdp/utils.js': [
  ['export function addPageBinding(type, name, prefix) {', '/**\n * @internal\n */\nexport const CDP_BINDING_PREFIX', "export function addPageBinding() {\n    throw new Error('native render SDK page binding refused');\n}\n"],
  ['    return evaluationString(addPageBinding, type, name, CDP_BINDING_PREFIX);', "    throw new Error('native render SDK page binding refused');"],
 ],
 'puppeteer/cdp/Frame.js': [
  ['        async addExposedFunctionBinding(binding) {', '        async waitForDevicePrompt(options = {}) {', "        async addExposedFunctionBinding() {\n            throw new Error('native render SDK page binding refused');\n        }\n        async removeExposedFunctionBinding() {\n            throw new Error('native render SDK page binding refused');\n        }\n"],
 ],
 'puppeteer/cdp/ExecutionContext.js': [
  ['    async #addBinding(binding) {', '    async #onBindingCalled(event) {', "    async #addBinding() {\n        throw new Error('native render SDK page binding refused');\n    }\n"],
 ],
} as const satisfies Record<string, readonly (readonly [string, string] | readonly [string, string, string])[]>;
const CONNECTOR = 'puppeteer/common/BrowserConnector.js';
const CONNECTOR_SOURCE = "/** @license Copyright 2023 Google Inc. SPDX-License-Identifier: Apache-2.0 */\nexport async function _connectToBrowser() { throw Error('native render SDK generic connector refused'); }\n";
const TRANSPORT = 'puppeteer/common/BrowserWebSocketTransport.js';
const TRANSPORT_SOURCE = "export class BrowserWebSocketTransport { constructor() { throw Error('native render SDK generic transport refused'); } static async create() { throw Error('native render SDK generic transport refused'); } }\n";
// Each deny-only transform is itself output pinned, separate from the two reviewed diagnostics transformations.
const REVIEWED = ['puppeteer/common/Debug.js', 'puppeteer/cloudflare/utils.js'];
const REQUIRED = [...REVIEWED, ...Object.keys(NATIVE_SDK_WORKER_OUTPUTS)];
export type SdkModuleReceipt = {
 module: string; inputSha256: string; outputSha256: string;
 steps: { policy: string; inputSha256: string; outputSha256: string }[];
};

function real(file: string): string {
 const parent = path.dirname(file);
 if (parent !== file) real(parent);
 if (lstatSync(file).isSymbolicLink()) refused('symlink: ' + file);
 return realpathSync(file);
}
function installed(root: string) {
 if (real(root) !== root) refused('noncanonical root');
 const dir = path.join(root, 'node_modules', SDK), esm = path.join(dir, 'lib/esm');
 real(esm);
 const declared = JSON.parse(readFileSync(real(path.join(root, 'package.json')), 'utf8'));
 const metadata = readFileSync(real(path.join(dir, 'package.json')));
 if (declared.dependencies?.[SDK] !== NATIVE_SDK_INPUT_PINS.version || sha(metadata) !== NATIVE_SDK_INPUT_PINS.packageSha256) refused('SDK package pin');
 const sources = new Map<string, string>();
 const walk = (dir: string) => {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
   const file = path.join(dir, item.name);
   if (item.isSymbolicLink()) refused('SDK symlink');
   if (item.isDirectory()) walk(file);
   else if (item.name.endsWith('.js') && !item.name.endsWith('.test.js')) {
    if (!item.isFile()) refused('SDK non-regular module');
    sources.set(slash(path.relative(esm, file)), new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)));
   }
  }
 };
 walk(esm);
 const inventory = [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([module, code]) => ({ module, sha256: sha(code) }));
 if (sources.size !== NATIVE_SDK_INPUT_PINS.modules || sha(JSON.stringify(inventory)) !== NATIVE_SDK_INPUT_PINS.esmInventorySha256) refused('SDK ESM inventory bytes');
 return { esm, sources };
}

/** Exact pinned input only; replayed output cannot pass the installed input comparison in the plugin. */
async function transform(module: string, source: string): Promise<{ code: string; receipt: SdkModuleReceipt }> {
 let code = source;
 const steps: SdkModuleReceipt['steps'] = [];
 if (REVIEWED.includes(module)) {
  const result = await applyNativeRenderSdkPolicy(module.slice('puppeteer/'.length), code);
  code = result.code;
  steps.push({ policy: result.policyId, inputSha256: result.inputSha256, outputSha256: result.outputSha256 });
 }
 if (module in NATIVE_SDK_WORKER_OUTPUTS) {
  const inputSha256 = sha(code);
  if (module === CONNECTOR) code = CONNECTOR_SOURCE;
  else if (module === TRANSPORT) code = TRANSPORT_SOURCE;
  else for (const edit of edits[module as keyof typeof edits]) {
   if (edit.length === 2) {
    if (code.split(edit[0]).length !== 2) refused('Worker transform shape: ' + module);
    code = code.replace(edit[0], edit[1]);
   } else {
    const [from, until, insert] = edit, start = code.indexOf(from), end = code.indexOf(until);
    if (code.split(from).length !== 2 || code.split(until).length !== 2 || end < start) refused('Worker transform shape: ' + module);
    code = code.slice(0, start) + insert + code.slice(end);
   }
  }
  code = code.replace(/\n\/\/# sourceMappingURL=[^\n]*/g, '');
  if (sha(code) !== NATIVE_SDK_WORKER_OUTPUTS[module]) refused('Worker transform output: ' + module);
  steps.push({ policy: 'clearcase.native-render-sdk-workers/1', inputSha256, outputSha256: sha(code) });
 }
 return { code, receipt: { module, inputSha256: sha(source), outputSha256: sha(code), steps } };
}

/** Vite/Kit server build only. Local is untouched; gate may build without SDK, but may not accidentally reach it.
 * Production MUST reach both reviewed transforms AND all Workers restrictions in the actual server graph.
 * Receipt is private build metadata, not a public asset or native/runtime acceptance.
 */
export function nativeRenderSdkBuild(a: { root: string; target: 'local' | 'hosted'; profile: HostedProfile }): Plugin | undefined {
 if (a.target === 'local') return undefined;
 const root = path.resolve(a.root);
 let inputs: ReturnType<typeof installed>;
 const records = new Map<string, SdkModuleReceipt>();
 const key = 'clearcaseNativeSdk';
 const nameOf = (id: string) => {
  const prefix = path.join(root, 'node_modules', SDK, 'lib/esm') + '/';
  if (id.startsWith(prefix) && !/[?#]/.test(id)) return slash(id.slice(prefix.length));
  if (id.includes('/@cloudflare/puppeteer/') || id.startsWith(SDK)) refused('wrong SDK root/path: ' + id);
  return null;
 };
 const receiptFile = path.join(root, '.local/native-render-sdk-build/ssr.json');
 return {
  name: 'clearcase-native-render-sdk-build', enforce: 'pre', apply: 'build',
  // Per-environment activation keeps Kit's client build separate from the required server closure.
  applyToEnvironment(environment) {
   if (environment.name === 'ssr') return true;
   return { name: 'clearcase-native-render-sdk-client-deny', enforce: 'pre', resolveId(id, importer) {
    if (id.includes(SDK) || importer?.includes('/@cloudflare/puppeteer/')) refused('SDK outside server build');
   } };
  },
  config() { return { ssr: { noExternal: [SDK] } }; },
  buildStart() {
   records.clear();
   real(root);
   mkdirSync(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
   real(path.dirname(receiptFile));
   rmSync(receiptFile, { force: true });
   if (a.profile === 'production') inputs = installed(root);
  },
  resolveId(id, importer) {
   if (id === 'node:buffer' && importer === BUFFER) return { id, external: true };
   if (id === DEBUG || id === BUFFER) refused('private adapter import');
   const from = importer ? nameOf(importer) : null;
   if (id === 'clearcase-native-render:host-buffer' || id === 'node:buffer' && from) {
    if (!from || !['puppeteer/common/util.js', 'puppeteer/api/Page.js', 'puppeteer/cdp/HTTPResponse.js'].includes(from)) refused('Buffer adapter edge');
    return BUFFER;
   }
   if (id === 'debug' && from === 'puppeteer/common/Debug.js') return DEBUG;
   if (id === SDK || id.startsWith(SDK + '/')) {
    if (a.profile !== 'production' || !importer || slash(path.relative(root, real(importer))) !== FACTORY || ![SDK, VERSION].includes(id)) refused('SDK construction edge');
    return path.join(inputs.esm, id === SDK ? 'puppeteer/puppeteer-cloudflare.js' : 'puppeteer/generated/version.js');
   }
   if (from) {
    if (!id.startsWith('.')) refused('unknown SDK import: ' + id);
    const resolved = path.resolve(path.dirname(importer!), id), module = nameOf(resolved);
    if (!module || !inputs.sources.has(module) || module.includes('/node/') || /globalPatcher\.js$/.test(module)) refused('unsupported SDK module: ' + id);
    real(resolved);
    return resolved;
   }
   // Never add a general filesystem/network/Buffer shim or alias for application/framework code.
   if (/^(?:node:)?(?:fs(?:\/.*)?|path|net|http|https|http2|tls|dgram|child_process|buffer)$/.test(id)) refused('non-SDK host capability: ' + id);
   if (path.isAbsolute(id) && nameOf(id)) refused('SDK path bypass');
  },
  load(id) {
   if (id === BUFFER) return BUFFER_SOURCE;
   if (id === DEBUG) return DEBUG_SOURCE;
   const module = nameOf(id);
   if (module) {
    if (a.profile !== 'production' || !inputs.sources.has(module)) refused('unapproved SDK module');
    real(id);
    const code = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(id));
    if (code !== inputs.sources.get(module)) refused('SDK bytes changed after inventory');
    return code;
   }
  },
  async transform(source, id) {
   if (id === BUFFER || id === DEBUG) return;
   const module = nameOf(id);
   if (!module) return;
   if (source !== inputs.sources.get(module)) refused('SDK input bytes/replay: ' + module);
   if (records.has(id)) refused('SDK transform replay: ' + module);
   const result = await transform(module, source);
   // Plugin metadata is mutable by other hooks; keep the authoritative hash record private.
   records.set(id, structuredClone(result.receipt));
   return { code: result.code, map: null, meta: { [key]: result.receipt } };
  },
  generateBundle: { order: 'post', handler(_options, bundle) {
   const graph = [...this.getModuleIds()];
   for (const id of graph) if ((id.includes(SDK) || id.includes('puppeteer')) && this.getModuleInfo(id)?.code == null) refused('externalized SDK bypass');
   const connected = new Set<string>();
   const visit = (id: string) => {
    if (connected.has(id)) return;
    connected.add(id);
    const info = this.getModuleInfo(id);
    for (const edge of [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]) visit(edge);
   };
   for (const id of graph) if (this.getModuleInfo(id)?.isEntry) visit(id);
   const reached = graph.filter(id => connected.has(id) && (id === BUFFER || id === DEBUG || nameOf(id)));
   if (a.profile !== 'production') { if (reached.length) refused('SDK in gate graph'); return; }
   const factory = path.join(root, FACTORY), factoryInfo = this.getModuleInfo(factory);
   if (!connected.has(factory) || !factoryInfo || !['puppeteer/puppeteer-cloudflare.js', 'puppeteer/generated/version.js'].every(module => factoryInfo.importedIds.includes(path.join(inputs.esm, module)))) refused('missing required transform: reachable SDK factory/entries');
   for (const id of reached.filter(id => id === BUFFER || id === DEBUG)) {
    const info = this.getModuleInfo(id), source = id === BUFFER ? BUFFER_SOURCE : DEBUG_SOURCE;
    if (!info || info.code !== source || info.dynamicallyImportedIds.length || info.importedIds.join() !== (id === BUFFER ? 'node:buffer' : '')) refused('adapter output/edge bypass');
    const allowed = id === BUFFER ? ['puppeteer/common/util.js', 'puppeteer/api/Page.js', 'puppeteer/cdp/HTTPResponse.js'] : ['puppeteer/common/Debug.js'];
    for (const parent of [...info.importers, ...info.dynamicImporters]) if (!allowed.includes(nameOf(parent) ?? '')) refused('adapter importer bypass');
   }
   const modules = reached.filter(id => nameOf(id)).map(id => {
    const record = records.get(id), info = this.getModuleInfo(id);
    if (!record || !info || info.code === null || sha(info.code) !== record.outputSha256 || JSON.stringify(info.meta[key]) !== JSON.stringify(record)) refused('missing actual transform: ' + id);
    for (const parent of [...info.importers, ...info.dynamicImporters]) {
     if (!nameOf(parent) && !(parent === factory && ['puppeteer/puppeteer-cloudflare.js', 'puppeteer/generated/version.js'].includes(record.module))) refused('SDK graph construction edge');
    }
    const edges = [...info.importedIds, ...info.dynamicallyImportedIds];
    for (const edge of edges) if (!reached.includes(edge)) refused('unapproved SDK graph edge: ' + edge);
    return { ...record, imports: edges.map(edge => nameOf(edge) ?? edge) };
   }).sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0);
   for (const module of REQUIRED) if (!modules.some(m => m.module === module && m.steps.length === 1)) refused('missing required transform: ' + module);
   const chunks = Object.values(bundle).filter(c => c.type === 'chunk');
   const emitted = chunks.map(c => ({ file: c.fileName, sha256: sha(c.code), bytes: new TextEncoder().encode(c.code).length, modules: Object.keys(c.modules).filter(id => reached.includes(id)).map(id => ({ module: nameOf(id) ?? id, renderedLength: c.modules[id]!.renderedLength })) }));
   // A reached-but-tree-shaken policy is not proof that the required closure was emitted.
   for (const module of REVIEWED) if (!emitted.some(c => c.modules.some(m => m.module === module && m.renderedLength > 0))) refused('required transform not emitted: ' + module);
   const receipt = {
    schema: NATIVE_SDK_BUILD_SCHEMA, policy: NATIVE_RENDER_SDK_POLICY, pins: NATIVE_SDK_INPUT_PINS,
    profile: a.profile, environment: this.environment.name, evidence: 'SCOPED-BUNDLE-NOT-NATIVE',
    hostRequirements: [{ module: 'node:buffer', compatibilityFlag: 'nodejs_compat' }, ...NATIVE_SDK_HOST_SYMBOLS.map(intrinsic => ({ intrinsic }))],
    entryModules: graph.filter(id => this.getModuleInfo(id)?.isEntry).map(id => slash(path.relative(root, id))),
    factory: FACTORY, modules,
    adapters: reached.filter(id => id === BUFFER || id === DEBUG).map(id => ({ module: id, outputSha256: sha(id === BUFFER ? BUFFER_SOURCE : DEBUG_SOURCE) })),
    chunks: emitted,
   };
   mkdirSync(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
   writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  } },
  buildEnd(error) { if (error) rmSync(receiptFile, { force: true }); },
  renderError() { rmSync(receiptFile, { force: true }); },
 };
}
