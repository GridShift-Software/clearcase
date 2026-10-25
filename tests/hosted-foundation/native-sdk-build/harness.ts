// Build-only synthetic Worker. Real factory and installed SDK bytes; no entry evaluation/runtime/provider calls.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, type Plugin, type UserConfig } from 'vite';
import { nativeRenderSdkBuild } from '../../../scripts/native-render-sdk-build.ts';
export const FACTORY = 'src/lib/viewer/hosted/native-render-check.ts';
export function fixture() {
 mkdirSync('.local', { recursive: true });
 const root = mkdtempSync(path.resolve('.local/native-sdk-build-'));
 const put = (file: string, source: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), source); };
 put('package.json', readFileSync('package.json', 'utf8'));
 cpSync('node_modules/@cloudflare/puppeteer', path.join(root, 'node_modules/@cloudflare/puppeteer'), { recursive: true });
 put(FACTORY, readFileSync(FACTORY, 'utf8'));
 put('scripts/native-render-sdk-policy.ts', readFileSync('scripts/native-render-sdk-policy.ts', 'utf8'));
 put('entry.ts', `import {createNativePreviewRenderChecker} from './${FACTORY}';
export default { async fetch(_request: Request, env: {render: Parameters<typeof createNativePreviewRenderChecker>[0]}) {
 return Response.json({present: !!(await createNativePreviewRenderChecker(env.render))});
}};`);
 return { root, put, dispose() { rmSync(root, { recursive: true, force: true }); } };
}
export async function bundle(root: string, options: { profile?: 'production' | 'hosted-gate'; plugins?: Plugin[]; config?: UserConfig } = {}) {
 const result = await build({ configFile: false, root, logLevel: 'silent',
  plugins: [nativeRenderSdkBuild({ root, target: 'hosted', profile: options.profile ?? 'production' }), ...(options.plugins ?? [])],
  build: { ssr: path.join(root, 'entry.ts'), write: false, minify: false, sourcemap: false, rolldownOptions: { output: { codeSplitting: false } } },
  ...options.config,
 });
 const outputs = Array.isArray(result) ? result : [result];
 return outputs.flatMap(item => { if (!('output' in item)) throw Error('unexpected bundle result'); return item.output.filter(item => item.type === 'chunk'); });
}
