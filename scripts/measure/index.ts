#!/usr/bin/env bun
// `bun run --bun measure --ticket <ID> ...`: performance measurement dispatcher.
//   --ticket CC-02  GRS-10's scripts/case-package/measure.ts, unchanged, with the same arguments
//   --ticket CC-03  scripts/measure/cc03.mjs (the local pilot: overview, warm navigation, PDF, download, start)
// The child inherits stdio; its exit code is returned. Anything else is a usage error (exit 2).
// This file only spawns: it imports no untyped harness module, so `tsc --noEmit -p .` checks it cleanly.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RUNNERS: Record<string, string> = {
	'CC-02': 'scripts/case-package/measure.ts',
	'CC-03': 'scripts/measure/cc03.mjs',
};
const repo = path.resolve(import.meta.dirname, '..', '..');
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
