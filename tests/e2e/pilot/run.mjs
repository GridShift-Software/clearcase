#!/usr/bin/env bun
// `bun run --bun test:e2e`: the ported browser and durability suites against the production build in ./build, each
// inside its own network namespace with only lo (tests/e2e/pilot/offline.sh), then the loopback bind check in the
// host namespace. Every server runs under Bun via scripts/pilot/start.ts. Exit 0 only when every step passes; a
// missing tool (unshare, ip, Chromium) or a failed isolation proof fails the run. Results: $CLEARCASE_REPORT_DIR/e2e.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHROME, chromeAvailable } from './lib/cdp.mjs';
import { outDir } from './lib/record.mjs';
import { bunIdentity } from './lib/server.mjs';

const here = import.meta.dirname;
const root = join(here, '..', '..', '..');
const which = (c) => spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
const pre = { unshare: which('unshare'), ip: which('ip'), chromium: chromeAvailable() ? CHROME : '', build: existsSync(join(root, 'build', 'handler.js')) && existsSync(join(root, 'build', 'clearcase-build.json')) };
const missing = Object.entries(pre).filter(([, v]) => !v).map(([k]) => k);
const dir = outDir();
mkdirSync(dir, { recursive: true });
const offline = (file) => ['unshare', ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`, join(here, 'offline.sh'), process.execPath, join(here, file)]];
const steps = [
	['browser suite (offline)', offline('suite.mjs')],
	['durability suite (offline)', offline('durability.mjs')],
	['loopback bind check (host namespace)', [process.execPath, [join(here, 'netcheck.mjs')]]],
];
const results = [];
if (missing.length) console.error(`test:e2e: missing prerequisites: ${missing.join(', ')} (build first with bun run --bun build)`);
else for (const [name, [cmd, args]] of steps) {
	const t0 = Date.now();
	console.log(`\n=== ${name}: ${cmd} ${args.join(' ')}`);
	const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CLEARCASE_E2E_OUT: dir } });
	results.push({ name, rc: r.status, ms: Date.now() - t0 });
}
const build = pre.build ? JSON.parse(readFileSync(join(root, 'build', 'clearcase-build.json'), 'utf8')) : null;
const ok = missing.length === 0 && results.length === steps.length && results.every((r) => r.rc === 0);
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ok, prerequisites: pre, missing, bun: bunIdentity(), build, results }, null, 1));
console.log('\n' + results.map((r) => `${r.rc === 0 ? 'PASS' : 'FAIL'} rc=${r.rc} ${(r.ms / 1000).toFixed(1)}s ${r.name}`).join('\n'));
process.exit(ok ? 0 : 1);
