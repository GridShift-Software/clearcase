#!/usr/bin/env bun
// `bun run --bun measure --ticket <ID> ...`: performance measurement dispatcher.
//   --ticket CC-02  GRS-10's scripts/case-package/measure.ts, unchanged, with the same arguments
//   --ticket CC-03  scripts/measure/cc03.mjs (the local pilot: overview, warm navigation, PDF, download, start)
//   --ticket CC-NN  scripts/measure/ccNN.mjs, when that file exists (an M2 owner adds its own; no change here)
// The child inherits stdio; its exit code is returned. Anything else is a usage error (exit 2).
// Fresh-build evidence (tests/e2e/pilot/lib/fresh-build.ts): the revision under test is --candidate REV when given,
// else the stamp of ./build, else the worktree itself (HEAD; a runner that builds nothing, such as CC-02's). It must be
// HEAD, built from and run on a tree without modified or untracked (not ignored) files; otherwise exit 2 before the
// runner starts, unless --allow-stale-build (the flag only; removed before the runner sees its arguments). The record,
// with `evidence: false` and the reasons when stale or overridden, goes to <out>/build-evidence-CC-NN.json (--out,
// else $CLEARCASE_REPORT_DIR/measure, else .local/measure), the runner gets CLEARCASE_BUILD_EVIDENCE=true|false, and
// the final status line says NOT EVIDENCE when it is false. A runner that aborted (a dead browser or a phase timeout,
// tests/e2e/pilot/lib/lifecycle.mjs; its <out>/measure-CC-NN.json of this run has `aborted`) makes the record
// `evidence: false` with the reason.
// This file only spawns and imports the typed fresh-build module, so `tsc --noEmit -p .` checks it cleanly.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALLOW_FLAG, allowStale, type BuildStamp, evidenceRecord, evidenceSuffix, freshLine, freshness, readStamp, refusal } from '../../tests/e2e/pilot/lib/fresh-build.ts';

const RUNNERS: Record<string, string> = {
	'CC-02': 'scripts/case-package/measure.ts',
	'CC-03': 'scripts/measure/cc03.mjs',
};
const repo = path.resolve(import.meta.dirname, '..', '..');
for (const f of readdirSync(import.meta.dirname).sort()) {
	const m = /^cc([0-9]{2})\.mjs$/.exec(f);
	if (m) RUNNERS[`CC-${m[1]}`] ??= path.relative(repo, path.join(import.meta.dirname, f));
}
const argv = process.argv.slice(2);
const args = argv.filter((a) => a !== ALLOW_FLAG);
const i = args.findIndex((a) => a === '--ticket' || a.startsWith('--ticket='));
const ticket = i < 0 ? undefined : args[i]!.includes('=') ? args[i]!.slice('--ticket='.length) : args[i + 1];
const runner = ticket ? RUNNERS[ticket] : undefined;
if (!runner) {
	console.error(`usage: bun run --bun measure --ticket ${Object.keys(RUNNERS).join('|')} --baseline REV --candidate REV [runner options]${ticket ? ` (unknown ticket ${ticket})` : ''}`);
	process.exit(2);
}
const opt = (n: string) => { const j = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); return j < 0 ? undefined : args[j]!.includes('=') ? args[j]!.slice(args[j]!.indexOf('=') + 1) : args[j + 1]; };
const candidate = opt('candidate');
const stampFile = path.join(repo, 'build', 'clearcase-build.json');
const resolved = candidate ? spawnSync('git', ['-C', repo, 'rev-parse', '--verify', `${candidate}^{commit}`], { encoding: 'utf8' }).stdout?.trim() || null : null;
const stamp: BuildStamp | null = candidate ? { revision: resolved, dirty: false } : existsSync(stampFile) ? readStamp(path.join(repo, 'build')) : { revision: spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || null, dirty: false };
const fresh = freshness(repo, stamp, candidate || !existsSync(stampFile) ? {} : { buildDir: path.join(repo, 'build') });
const allowed = allowStale(argv);
const record = { ticket, runner, underTest: candidate ? `--candidate ${candidate}` : existsSync(stampFile) ? 'build/clearcase-build.json' : 'worktree (no build)', ...evidenceRecord(fresh, allowed) };
const outArg = opt('out');
const out = path.resolve(outArg ?? (process.env.CLEARCASE_REPORT_DIR ? path.join(process.env.CLEARCASE_REPORT_DIR, 'measure') : path.join(repo, '.local', 'measure')));
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `build-evidence-${ticket}.json`), JSON.stringify(record, null, 1) + '\n');
console.error(`measure: ${freshLine(fresh)}`);
if (!fresh.fresh && !allowed) { console.error(refusal('measure', fresh)); process.exit(2); }
const started = Date.now();
const r = spawnSync(process.execPath, [path.join(repo, runner), ...args], { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, CLEARCASE_BUILD_EVIDENCE: String(record.evidence) } });
if (r.error) { console.error(`measure: cannot run ${runner}: ${r.error.message}`); process.exit(2); }
const resultFile = path.join(out, `measure-${ticket}.json`);
const aborted = (() => { try { return statSync(resultFile).mtimeMs >= started ? JSON.parse(readFileSync(resultFile, 'utf8')).aborted ?? null : null; } catch { return null; } })();
const final = aborted ? { ...record, ...evidenceRecord(fresh, allowed, [`run aborted in ${aborted.step}: ${aborted.cause}`]), aborted } : record;
if (aborted) writeFileSync(path.join(out, `build-evidence-${ticket}.json`), JSON.stringify(final, null, 1) + '\n');
console.error(`measure: ${ticket} exit ${r.status ?? 1}${evidenceSuffix(final)}`);
process.exit(r.status ?? 1);
