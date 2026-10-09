#!/usr/bin/env bun
// `bun run --bun measure --ticket <ID> ...`: performance measurement dispatcher.
//   --ticket CC-02  GRS-10's scripts/case-package/measure.ts, unchanged, with the same arguments
//   --ticket CC-03  scripts/measure/cc03.mjs (the local pilot: overview, warm navigation, PDF, download, start)
//   --ticket CC-NN  scripts/measure/ccNN.mjs, when that file exists (an M2 owner adds its own; no change here)
// The child inherits stdio; its exit code is returned. Anything else is a usage error (exit 2).
// This file only spawns: it imports no untyped harness module, so `tsc --noEmit -p .` checks it cleanly.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const RUNNERS: Record<string, string> = {
	'CC-02': 'scripts/case-package/measure.ts',
	'CC-03': 'scripts/measure/cc03.mjs',
};
const repo = path.resolve(import.meta.dirname, '..', '..');
for (const f of readdirSync(import.meta.dirname).sort()) {
	const m = /^cc([0-9]{2})\.mjs$/.exec(f);
	if (m) RUNNERS[`CC-${m[1]}`] ??= path.relative(repo, path.join(import.meta.dirname, f));
}
const args = process.argv.slice(2);
const i = args.findIndex((a) => a === '--ticket' || a.startsWith('--ticket='));
const ticket = i < 0 ? undefined : args[i]!.includes('=') ? args[i]!.slice('--ticket='.length) : args[i + 1];
const runner = ticket ? RUNNERS[ticket] : undefined;
if (!runner) {
	console.error(`usage: bun run --bun measure --ticket ${Object.keys(RUNNERS).join('|')} --baseline REV --candidate REV [runner options]${ticket ? ` (unknown ticket ${ticket})` : ''}`);
	process.exit(2);
}
const r = spawnSync(process.execPath, [path.join(repo, runner), ...args], { stdio: 'inherit', cwd: process.cwd() });
if (r.error) { console.error(`measure: cannot run ${runner}: ${r.error.message}`); process.exit(2); }
process.exit(r.status ?? 1);
