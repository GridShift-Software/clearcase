// Host-only probes: each mutation is committed in a disposable checkout before the actual check command runs.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const base = git(['rev-parse', 'HEAD']);
if (git(['status', '--porcelain'])) throw new Error('Guard probes require a clean committed source tree');
if (execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim() !== '1.4.2') throw new Error('Bun 1.4.2 required');
const evidence = path.resolve(root, '..', `guard-evidence-${base.slice(0, 12)}`);
mkdirSync(evidence, { recursive: true });
const hooks = 'src/lib/server/runtime/hosted/hooks.server.ts';
const prefix = 'src/lib/server/runtime/';
const variants = [
  { name: 'safe-type-import', expected: null, files: { [hooks]: "import type { Version } from '$lib/local-case/store.server';\n" } },
  { name: 'host-only-tool', expected: null, files: { 'tests/hosted-foundation/runtime/host-only-probe.ts': "import 'node:fs';\n" } },
  { name: 'alias-reexport-dynamic-local', expected: 'forbidden local implementation', files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: "export * from './probe-middle';\n", [prefix + 'probe-middle.ts']: "export const loadLocal = () => import('$lib/local-case/db.server');\n" } },
  ...['node:fs/promises', 'fs', 'node:sqlite', 'node:net', 'node:http', 'bun:sqlite'].map((specifier) => ({ name: specifier.replace(/[^a-z]+/g, '-'), expected: `forbidden capability ${specifier}`, files: { [hooks]: "import '$lib/server/runtime/probe-entry';\n", [prefix + 'probe-entry.ts']: `import '${specifier}';\n` } })),
  { name: 'selected-hidden-route', expected: 'forbidden capability node:net', files: { 'src/lib/server/runtime/hosted/routes/probe/+server.ts': "import 'node:net'; export const GET = () => new Response();\n" } },
];
const results: { name: string; sha: string; exitCode: number | null; expected: string | null; pass: boolean; log: string; sha256: string }[] = [];
for (const variant of variants) {
  const checkout = mkdtempSync(path.resolve(root, '..', `guard-probe-${variant.name}-`));
  let attached = false;
  try {
    // mkdtemp reserves the owned path; worktree add expects it to be absent or empty.
    git(['worktree', 'add', '--quiet', '--detach', checkout, base]); attached = true;
    symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
    mkdirSync(path.join(checkout, '.svelte-kit'), { recursive: true });
    copyFileSync(path.join(root, '.svelte-kit/tsconfig.json'), path.join(checkout, '.svelte-kit/tsconfig.json'));
    for (const [name, text] of Object.entries(variant.files)) {
      const filename = path.join(checkout, name); mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, text + (name === hooks ? readFileSync(filename, 'utf8') : ''));
    }
    git(['add', '.'], checkout);
    git(['commit', '--quiet', '-m', `probe: ${variant.name}`, '-m', 'Co-Authored-By: gpt-6.1-sol <noreply@openai.com>'], checkout);
    const sha = git(['rev-parse', 'HEAD'], checkout);
    if (git(['status', '--porcelain'], checkout)) throw new Error('Mutation is dirty before check');
    const command = variant.expected === null ? ['run', '--bun', 'check:hosted-imports'] : ['run', '--bun', 'check'];
    const run = spawnSync('bun', command, { cwd: checkout, encoding: 'utf8', timeout: 30_000 });
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
