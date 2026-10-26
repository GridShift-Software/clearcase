// Source-graph evidence for the NEW otherwise-uncomposed factory. This runs the repository's real hosted guard against
// a temporary source-only root, not an alternate implementation, runtime build, provider or native renderer.
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';

it('admits the actual publication material graph with only the already allowed crypto host exception', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cc-publication-graph-'));
  try {
    cpSync('src', path.join(root, 'src'), { recursive: true });
    cpSync('deploy', path.join(root, 'deploy'), { recursive: true });
    symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
    mkdirSync(path.join(root, 'entry'));
    writeFileSync(path.join(root, 'entry/+server.ts'), "export { createPublicationMaterialReader } from '../src/lib/server/runtime/hosted/publication-material.ts';\n");
    writeFileSync(path.join(root, 'entry/hooks.server.ts'), 'export {};\n');
    writeFileSync(path.join(root, 'deploy/client/hosted-files.json'), JSON.stringify({ routes: 'entry', hooks: { server: 'entry/hooks.server' } }));
    writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'preserve',
      paths: { '$lib/*': ['./src/lib/*'] }, allowImportingTsExtensions: true } }));
    const result = checkHostedGraph({ root });
    expect(result.errors).toEqual([]);
    expect(result.files).toContain('src/lib/server/runtime/hosted/publication-material.ts');
    expect(result.files).toContain('src/lib/case-package/hosted-validation.ts');
    expect(result.files).toContain('deploy/client/routes/cases/[caseId]/views/[resultsVersion]/chronology/+page.svelte');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
