import { describe, expect, it } from 'vitest';
import { id, sha256, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { createUnavailableServices } from '../../../src/lib/server/runtime/unavailable.ts';
import { validateBuildStamp } from '../../../src/lib/server/runtime/build.ts';

describe('runtime boundary contracts', () => {
  it('brands only validated ids and digests', () => {
    expect(id('case', 'case-a')).toBe('case-a');
    for (const value of ['', '../case', 'a\u0000b']) expect(() => id('case', value)).toThrow();
    expect(sha256('a'.repeat(64))).toBe('a'.repeat(64));
    expect(resultsVersion('sha256:' + 'b'.repeat(64))).toBe('sha256:' + 'b'.repeat(64));
    expect(() => sha256('a'.repeat(63))).toThrow();
    expect(() => resultsVersion('not-a-digest')).toThrow();
  });
  it('constructs all six handles without a memory fallback', async () => {
    const locals = createUnavailableServices({ clientId: id('client', 'client-a'), now: () => new Date('2026-10-17T00:00:00Z') });
    expect(Object.keys(locals).sort()).toEqual(['assets', 'audit', 'identity', 'runtime', 'store', 'userWork']);
    expect(locals.identity.kind).toBe('anonymous');
    await expect(locals.identity.checkRevocation()).rejects.toMatchObject({ code: 'identity-unavailable', retryable: true });
    await expect(locals.store.listCases()).rejects.toMatchObject({ code: 'storage-unavailable' });
    await expect(locals.userWork.notesFor({ caseId: id('case', 'empty'), target: null })).rejects.toMatchObject({ code: 'storage-unavailable' });
    await expect(locals.runtime.probe()).rejects.toMatchObject({ code: 'missing-binding' });
    expect(() => locals.runtime.build).toThrow('invalid-build');
    expect(locals.runtime.now().toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });
  it('requires a full, exact hosted build stamp without runtime overrides', () => {
    const stamp = { revision: 'a'.repeat(40), dirty: false, exported: true, builtAt: '2026-10-17T00:00:00Z', bun: '1.4.2', buildId: 'build-1', target: 'cloudflare', profile: 'production' };
    expect(validateBuildStamp(stamp)).toEqual(stamp);
    for (const mutation of [{ revision: 'abc' }, { bun: '1.4.1' }, { target: 'node' }, { profile: 'unknown' }, { dirty: 'false' }, { builtAt: 'invalid' }]) {
      expect(() => validateBuildStamp({ ...stamp, ...mutation })).toThrow();
    }
  });
});
