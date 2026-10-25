import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigEnv, Plugin } from 'vite';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  prepare: vi.fn(),
  kit: vi.fn(() => [{ name: 'synthetic-kit-adapter' }]),
}));
vi.mock('../../../scripts/hosted-static-input.ts', () => ({ prepareHostedStaticInput: mocks.prepare }));
vi.mock('@sveltejs/kit/vite', () => ({ sveltekit: mocks.kit }));
vi.mock('@sveltejs/adapter-cloudflare', () => ({ default: () => ({ name: 'synthetic-cloudflare' }) }));
vi.mock('@sveltejs/adapter-node', () => ({ default: () => ({ name: 'synthetic-node' }) }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });
async function config(target: string, command: ConfigEnv['command'] = 'build', isPreview = false) {
  vi.stubEnv('CLEARCASE_TARGET', target); vi.stubEnv('CLEARCASE_HOSTED_PROFILE', undefined);
  mocks.prepare.mockReturnValue({ assets: '/synthetic/owned-input', dispose: mocks.dispose });
  const { default: create } = await import('../../../vite.config.ts');
  if (typeof create !== 'function') throw new Error('expected config factory');
  return await create({ command, mode: 'production', isPreview });
}
describe('hosted static input configuration (not a build/provenance proof)', () => {
  it('prepares before Kit and gives Kit the real files.assets input', async () => {
    const result = await config('hosted');
    expect(mocks.prepare).toHaveBeenCalledWith(process.cwd());
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.kit.mock.invocationCallOrder[0]!);
    expect(mocks.kit).toHaveBeenCalledWith(expect.objectContaining({ files: expect.objectContaining({ assets: '/synthetic/owned-input' }) }));
    expect(result.plugins?.at(-1)).toMatchObject({ name: 'clearcase-hosted-static-input', buildApp: { order: 'post', sequential: true } });
    expect(mocks.dispose).not.toHaveBeenCalled();
    const cleanup = result.plugins?.at(-1) as Plugin;
    const hook = cleanup.buildApp;
    if (!hook || typeof hook === 'function') throw new Error('expected ordered cleanup');
    await Reflect.apply(hook.handler, undefined, []);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it.each([['local', 'build', false], ['hosted', 'serve', false], ['hosted', 'serve', true]] as const)('leaves %s %s preview=%s unchanged', async (target, command, preview) => {
    await config(target, command, preview);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.kit).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.objectContaining({ assets: expect.any(String) }) }));
  });
  it('disposes when Kit configuration fails', async () => {
    mocks.kit.mockImplementationOnce(() => { throw new Error('synthetic Kit failure'); });
    await expect(config('hosted')).rejects.toThrow('synthetic Kit failure');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('disposes on an environment build error but not a successful environment buildEnd', async () => {
    const result = await config('hosted');
    const cleanup = result.plugins?.at(-1) as Plugin;
    const hook = cleanup.buildEnd;
    if (typeof hook !== 'function') throw new Error('expected error cleanup');
    await Reflect.apply(hook, undefined, []);
    expect(mocks.dispose).not.toHaveBeenCalled();
    await Reflect.apply(hook, undefined, [new Error('synthetic build failure')]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('keeps the strict CSP unchanged (self script/default sources also restrict workers)', async () => {
    await config('hosted');
    expect(mocks.kit).toHaveBeenCalledWith(expect.objectContaining({ csp: expect.objectContaining({ directives: expect.objectContaining({ 'default-src': ['self'], 'script-src': ['self'], 'object-src': ['none'] }) }) }));
  });
  it('preserves target validation', async () => { await expect(config('typo')).rejects.toThrow('CLEARCASE_TARGET must'); expect(mocks.prepare).not.toHaveBeenCalled(); });
  it.each(['typo', 'hosted-gate'])('preserves profile validation for local target with %s', async profile => {
    vi.stubEnv('CLEARCASE_TARGET', 'local'); vi.stubEnv('CLEARCASE_HOSTED_PROFILE', profile);
    await expect(import('../../../vite.config.ts')).rejects.toThrow('CLEARCASE_HOSTED_PROFILE');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
