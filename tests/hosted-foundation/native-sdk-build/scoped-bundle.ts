// Build-only proof using the exact plugin, the REAL factory/SDK and the unchanged native module scanner.
// Emits private evidence only. A native refusal is a nonzero exit, never waived or renamed PASS.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanModule } from '../../../deploy/probes/target.ts';
import { uploadModuleProblems } from '../../../deploy/native-alpha/pipeline.ts';
import { bundle, fixture } from './harness.ts';
const f = fixture();
const chunks = await bundle(f.root);
const out = path.join(f.root, '.local/scoped-emitted');
mkdirSync(out, { recursive: true });
const scanned = chunks.map(chunk => {
 writeFileSync(path.join(out, chunk.fileName), chunk.code);
 const facts = scanModule(chunk.code);
 return { file: chunk.fileName, facts, problems: uploadModuleProblems(facts, chunk.fileName, ['nodejs_compat']) };
});
console.log(JSON.stringify({ scope: 'SCOPED-BUNDLE-NOT-NATIVE', root: f.root, receipt: path.join(f.root, '.local/native-render-sdk-build/ssr.json'), emitted: out, scanned }, null, 2));
process.exitCode = scanned.some(s => s.problems.length) ? 1 : 0;
