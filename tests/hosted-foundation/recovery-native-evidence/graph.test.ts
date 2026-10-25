// Static forced-root production graphs only: no build, server, browser, Worker or provider execution.
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';
it('admits all new native evidence entry modules as explicit production roots', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'clearcase-native-evidence-graph-'));
  const put = (path: string, data: string) => { mkdirSync(dirname(join(scratch, path)), { recursive: true }); writeFileSync(join(scratch, path), data); };
  try {
    cpSync('src/lib', join(scratch, 'src/lib'), { recursive: true });
    put('routes/+server.ts', 'export {};');
    put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler', verbatimModuleSyntax: true } }));
    symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
    for (const name of ['native-evidence', 'export', 'restore']) {
      put('deploy/client/hosted-files.json', JSON.stringify({ routes: 'routes', hooks: { server: `src/lib/recovery/hosted/${name}` } }));
      const result = checkHostedGraph({ root: scratch });
      expect(result.errors).toEqual([]); expect(result.files).toContain(`src/lib/recovery/hosted/${name}.ts`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
