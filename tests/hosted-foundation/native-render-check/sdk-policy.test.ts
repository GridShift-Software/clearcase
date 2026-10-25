// Executes pinned SDK SOURCE with inert dependencies only. No real SDK launch, browser, provider or workerd.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyNativeRenderSdkPolicy, NATIVE_RENDER_SDK_POLICY } from '../../../scripts/native-render-sdk-policy.ts';

const source = (file: string) => readFileSync('node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/' + file, 'utf8');
describe('required parent SDK build-policy hook (NOT native artifact acceptance)', () => {
 it.each(['common/Debug.js', 'cloudflare/utils.js'])('accepts only the exact pinned source once: %s', async path => {
  const original = source(path), patched = await applyNativeRenderSdkPolicy(path, original);
  expect(patched.policyId).toBe(NATIVE_RENDER_SDK_POLICY);
  expect(patched.outputSha256).not.toBe(patched.inputSha256);
  expect(patched.code).not.toContain('sourceMappingURL=');
  await expect(applyNativeRenderSdkPolicy(path, original + '\n')).rejects.toThrow(/source refused/);
  await expect(applyNativeRenderSdkPolicy(path, patched.code)).rejects.toThrow(/source refused/);
 });
 it('refuses unrelated modules instead of broad SDK/global patching', async () => {
  await expect(applyNativeRenderSdkPolicy('cdp/Browser.js', source('cloudflare/utils.js'))).rejects.toThrow(/module refused/);
 });

 it.each([false, true])('keeps enabled audit events and capture without raw protocol/errors: isNode=%s', async isNode => {
  const patched = await applyNativeRenderSdkPolicy('common/Debug.js', source('common/Debug.js'));
  const log = vi.fn(), sink = vi.fn();
  // Local sandbox parameters only; the actual console/process and SDK module are never patched.
  const install = new Function('isNode', 'process', 'globalThis', 'console', 'sink',
   patched.code.replace("import { isNode } from '../environment.js';", '').replaceAll('export ', '') +
    '; debugModule = () => sink; return { debug, setLogCapture, getCapturedLogs };');
  const env = { DEBUG: '' }, global = { __PUPPETEER_DEBUG: '' };
  const api = install(isNode, { env }, global, { log }, sink);
  const canary = 'SYNTHETIC_PROTOCOL_SESSION_ERROR_SECRET_CANARY';
  const payload = { toString() { throw Error('raw payload must not be coerced'); } };
  api.setLogCapture(true);
  await api.debug('puppeteer:error')(canary, payload);
  expect(log).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled();
  env.DEBUG = '*'; global.__PUPPETEER_DEBUG = '*';
  await api.debug('puppeteer:error')(Error(canary), { sessionId: canary }, payload);
  const events = isNode ? sink.mock.calls : log.mock.calls;
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).toContain('[native render SDK event]');
  expect(JSON.stringify(events)).not.toContain(canary);
  expect(api.getCapturedLogs()).toEqual(isNode ? [
   'puppeteer:error: [native render SDK event]', 'puppeteer:error: [native render SDK event]',
  ] : []);
 });

 it.each(['raw', 'coded'])('the pinned fallback close callback propagates a sanitized rejection: %s', async mode => {
  const patched = await applyNativeRenderSdkPolicy('cloudflare/utils.js', source('cloudflare/utils.js'));
  const canary = 'SYNTHETIC_CLOSE_SESSION_SECRET_CANARY';
  const fault = mode === 'raw' ? canary : Object.assign(Error(canary), { code: canary });
  const log = vi.fn(), callbacks: (() => Promise<unknown>)[] = [];
  // Test only the real SDK helper/callback source; construction and protocol calls remain inert doubles.
  const install = new Function('CdpBrowser', 'Connection', 'console',
   patched.code.replace("import { CdpBrowser } from '../cdp/Browser.js';", '').replace("import { Connection } from '../cdp/Connection.js';", '').replaceAll('export ', '') + '; return connectToCDPBrowser;');
  class InertConnection {
   async send(method: string) {
    if (method === 'Browser.getVersion') return { product: 'Chrome' };
    if (method === 'Target.getBrowserContexts') return { browserContextIds: [] };
    throw fault;
   }
  }
  const connect = install({ _create: async (...args: unknown[]) => { callbacks.push(args[6] as () => Promise<unknown>); return {}; } }, InertConnection, { log });
  await connect({}, {});
  await expect(callbacks[0]!()).rejects.toThrow('native render SDK close refused');
  expect(log).not.toHaveBeenCalled();
 });
});
