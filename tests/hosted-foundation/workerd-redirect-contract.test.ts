// Negative controls for the workerd redirect rule double itself: it must refuse what workerd refuses, pass what workerd
// accepts, and leave the Bun builtins exactly as they were once restored. NOT workerd evidence.
import { afterEach, describe, expect, it } from 'vitest';
import { installWorkerdRedirectContract } from './workerd-redirect-contract.ts';

const builtinRequest = globalThis.Request, builtinFetch = globalThis.fetch;
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

describe('workerd redirect rule double', () => {
 it('refuses redirect error and any unknown mode when a Request is constructed, from a URL or from a Request', () => {
  restore = installWorkerdRedirectContract();
  for (const redirect of ['error', 'bogus'] as const) {
   expect(() => new Request('https://app.example/x', { redirect: redirect as RequestRedirect })).toThrow(TypeError);
   expect(() => new Request(new Request('https://app.example/x'), { redirect: redirect as RequestRedirect })).toThrow(TypeError);
  }
 });
 it('constructs follow, manual and the default as the unchanged builtin', () => {
  restore = installWorkerdRedirectContract();
  const seen = [new Request('https://app.example/x'), new Request('https://app.example/x', { redirect: 'follow' }), new Request('https://app.example/x', { redirect: 'manual', method: 'GET' })];
  expect(seen.map(r => r.redirect)).toEqual(['follow', 'follow', 'manual']);
  for (const request of seen) { expect(request).toBeInstanceOf(builtinRequest); expect(request.url).toBe('https://app.example/x'); }
 });
 it('rejects fetch with redirect error before any network, and lets manual through to the builtin', async () => {
  restore = installWorkerdRedirectContract();
  await expect(fetch('http://127.0.0.1:1/never', { redirect: 'error' })).rejects.toBeInstanceOf(TypeError);
  await expect(fetch('data:text/plain,ok', { redirect: 'manual' }).then(r => r.text())).resolves.toBe('ok');
 });
 it('puts the exact builtins back', () => {
  installWorkerdRedirectContract()();
  expect(globalThis.Request).toBe(builtinRequest); expect(globalThis.fetch).toBe(builtinFetch);
  expect(() => new Request('https://app.example/x', { redirect: 'error' })).not.toThrow();
 });
});
