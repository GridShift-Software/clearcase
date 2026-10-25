// Forced-root static import check: no build, provider, Worker or runtime launch.
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';

it('admits the NEW adapter as a forced production graph root, not just the unwired app', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'clearcase-recovery-native-graph-'));
  const put = (file: string, data: string) => { mkdirSync(dirname(join(scratch, file)), { recursive: true }); writeFileSync(join(scratch, file), data); };
  try {
    cpSync('src/lib', join(scratch, 'src/lib'), { recursive: true });
    put('routes/+server.ts', 'export {};');
    put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler', verbatimModuleSyntax: true } }));
    put('deploy/client/hosted-files.json', JSON.stringify({ routes: 'routes', hooks: { server: 'src/lib/recovery/hosted/native-adapters' } }));
    symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
    const result = checkHostedGraph({ root: scratch });
    expect(result.errors).toEqual([]);
    expect(result.files).toContain('src/lib/recovery/hosted/native-adapters.ts');
    expect(result.files).toContain('src/lib/results/hosted/assets.ts');
    expect(result.files).toContain('src/lib/user-work/hosted/d1-user-work.ts');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
