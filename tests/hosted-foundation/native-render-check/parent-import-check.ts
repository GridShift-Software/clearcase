// Static integration diagnostic only. Does not import/evaluate the SDK, run workerd or contact a provider.
// The existing production graph does NOT reach the new checker until the parent composes it. Force this one new
// module into an isolated guard root so a green unchanged app guard cannot be mistaken for admission of the SDK.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkHostedGraph } from '../../../scripts/ci/hosted-imports.ts';

const scratch = mkdtempSync(join(tmpdir(), 'clearcase-native-pdf-import-'));
try {
 const module = 'src/lib/viewer/hosted/native-render-check.ts';
 const put = (file: string, data: string) => { mkdirSync(dirname(join(scratch, file)), { recursive: true }); writeFileSync(join(scratch, file), data); };
 put(module, readFileSync(module, 'utf8'));
 put('routes/+server.ts', 'export {};');
 put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler', verbatimModuleSyntax: true } }));
 put('deploy/client/hosted-files.json', JSON.stringify({ routes: 'routes', hooks: { server: module.slice(0, -3) } }));
 symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
 const report = checkHostedGraph({ root: scratch });
 for (const error of report.errors) console.error(error);
 console.log(`native PDF forced-root guard: ${report.errors.length ? 'FAIL (parent allowance required)' : 'PASS'}; ${report.files.length} source modules`);
 process.exitCode = report.errors.length ? 1 : 0;
} finally { rmSync(scratch, { recursive: true, force: true }); }
