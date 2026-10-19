// Host-only probes: each mutation is committed in a disposable checkout before the actual check command runs.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const base = git(['rev-parse', 'HEAD']);
if (git(['status', '--porcelain'])) throw new Error('Guard probes require a clean committed source tree');
if (execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim() !== '1.4.2') throw new Error('Bun 1.4.2 required');
// Evidence and the disposable checkouts stay in this worktree's ignored .local/hosted/.
const evidence = path.join(root, '.local', 'hosted', `guard-evidence-${base.slice(0, 12)}`);
mkdirSync(evidence, { recursive: true });
const hooks = 'src/lib/server/runtime/hosted/hooks.server.ts';
const prefix = 'src/lib/server/runtime/';
const variants = [
  { name: 'safe-type-import', expected: null, files: { [hooks]: "import type { Version } from '$lib/local-case/store.server';\n" } },
  { name: 'host-only-tool', expected: null, files: { 'tests/hosted-foundation/runtime/host-only-probe.ts': "import 'node:fs';\n" } },
  { name: 'alias-reexport-dynamic-local', expected: 'forbidden local implementation', files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "export * from './probe-middle';\n", [prefix + 'probe-middle.ts']: "export const loadLocal = () => import('$lib/local-case/db.server');\n" } },
  ...['node:fs/promises', 'fs', 'node:sqlite', 'node:net', 'node:http', 'bun:sqlite'].map((specifier) => ({ name: specifier.replace(/[^a-z]+/g, '-'), expected: `forbidden capability ${specifier}`, files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: `import '${specifier}';\n` } })),
  { name: 'selected-hidden-route', expected: 'forbidden capability node:net', files: { 'deploy/client/routes/probe/+server.ts': "import 'node:net'; export const GET = () => new Response();\n" } },
  // Vite glob edges, in the forms the guard matches exactly: a $lib pattern and a root-relative ** pattern
  { name: 'vite-glob-edge', expected: 'forbidden local implementation', files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "export const modules = import.meta.glob('$lib/local-case/*.server.ts', { eager: true });\n" } },
  { name: 'vite-glob-doublestar', expected: 'forbidden local implementation', files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "export const modules = import.meta.glob('/src/lib/**/db.server.ts');\n" } },
  { name: 'computed-import', expected: 'computed runtime import', files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "const name = ['node', 'fs'].join(':');\nexport const load = () => import(name);\n" } },
  { name: 'svelte-script-block', expected: 'forbidden capability node:fs', files: { 'deploy/client/routes/probe/+page.svelte': "<script lang=\"ts\">\n\timport { readFileSync } from 'node:fs';\n\tconst text = readFileSync('/etc/hostname', 'utf8');\n</script>\n\n<p>{text}</p>\n" } },
  { name: 're-export-chain', expected: 'forbidden capability node:sqlite', files: { [hooks]: "export * from '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "export * from './probe-middle';\n", [prefix + 'probe-middle.ts']: "export { probe } from './probe-last';\n", [prefix + 'probe-last.ts']: "export * as probe from 'node:sqlite';\n" } },
  { name: 'process-listener', expected: 'forbidden capability process', files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "process.on('SIGTERM', () => {});\n" } },
  { name: 'package-outside-allowlist', expected: 'package outside the hosted allowlist fflate', files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "export { unzipSync } from 'fflate';\n" } },
  { name: 'local-browse-route', expected: 'forbidden local route module', files: { 'deploy/client/routes/api/browse/+server.ts': "export { GET } from '../../../../../src/routes/api/browse/+server.ts';\n" } },
  // the test doubles: the memory doubles never, and the hosted-gate doubles never in the production profile
  { name: 'memory-double-in-production', expected: 'forbidden test double in the production graph', files: { [hooks]: "import { createMemoryBackend } from '$lib/server/runtime/memory';\nexport const memory = createMemoryBackend;\n" } },
  { name: 'gate-double-in-production', expected: 'forbidden test double in the production graph', files: { [hooks]: "export { gateServices } from './gate/services.ts';\n" } },
];
const results: { name: string; sha: string; exitCode: number | null; expected: string | null; pass: boolean; log: string; sha256: string }[] = [];
for (const variant of variants) {
  const checkout = mkdtempSync(path.join(root, '.local', 'hosted', `guard-probe-${variant.name}-`));
  let attached = false;
  try {
    // mkdtemp reserves the owned path; worktree add expects it to be absent or empty.
    git(['worktree', 'add', '--quiet', '--detach', checkout, base]); attached = true;
    // Every installed package by symlink, except Kit 3's generated node_modules/$app: `svelte-kit sync` writes the
    // checkout's own, so a probe never resolves $lib against (or rewrites) this worktree's generated tsconfig.
    mkdirSync(path.join(checkout, 'node_modules'));
    for (const entry of readdirSync(path.join(root, 'node_modules'))) if (entry !== '$app') symlinkSync(path.join(root, 'node_modules', entry), path.join(checkout, 'node_modules', entry));
    for (const [name, text] of Object.entries(variant.files)) {
      const filename = path.join(checkout, name); mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, text + (name === hooks ? readFileSync(filename, 'utf8') : ''));
    }
    git(['add', '.'], checkout);
    git(['commit', '--quiet', '-m', `probe: ${variant.name}`, '-m', 'Co-Authored-By: gpt-6.1-sol <noreply@openai.com>'], checkout);
    const sha = git(['rev-parse', 'HEAD'], checkout);
    if (git(['status', '--porcelain'], checkout)) throw new Error('Mutation is dirty before check');
    const sync = spawnSync('bun', ['run', '--bun', 'svelte-kit', 'sync'], { cwd: checkout, encoding: 'utf8', timeout: 60_000 });
    if (sync.status !== 0) throw new Error(`svelte-kit sync failed in ${checkout}: ${sync.stdout}${sync.stderr}`);
    const command = variant.expected === null ? ['run', '--bun', 'check:hosted-imports'] : ['run', '--bun', 'check'];
    const run = spawnSync('bun', command, { cwd: checkout, encoding: 'utf8', timeout: 60_000 });
    if (run.error) throw run.error;
    const output = run.stdout + run.stderr, log = path.join(evidence, `${variant.name}.log`);
    writeFileSync(log, output);
    const pass = variant.expected === null ? run.status === 0 : run.status !== 0 && output.includes('hosted-import:') && output.includes(variant.expected);
    if (git(['status', '--porcelain'], checkout)) throw new Error('Mutation changed during check');
    const row = { name: variant.name, sha, exitCode: run.status, expected: variant.expected, pass, log, sha256: createHash('sha256').update(output).digest('hex') };
    results.push(row);
    console.log(`${pass ? 'PASS' : 'FAIL'} ${variant.name} ${sha} exit=${run.status}`);
    if (!pass) throw new Error(`Unexpected guard result; see ${log}`);
  } finally {
    if (attached) git(['worktree', 'remove', '--force', checkout]); else rmSync(checkout, { recursive: true, force: true });
    writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ base, command: 'bun run --bun check (negative) / check:hosted-imports (positive)', scope: 'selected-source-graph', workersEvidence: false, results }, null, 2) + '\n');
  }
}
