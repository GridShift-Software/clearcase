#!/usr/bin/env bun
// Performance measurement for CC-02: conversion plus full validation of the v5 sample from the
// extracted case folder (`cli.ts convert`, which converts, writes the package and runs
// importCandidate with every referenced original hashed). Each sample is a fresh Bun process.
//
//   bun run --bun measure --ticket CC-02 --baseline <rev> --candidate <rev>
//       [--samples 20] [--warmup 2] [--cold 3] [--baseline-median MS]
//       [--fixture-config .local/v5-verification.json] [--out DIR]
//
// Each revision is measured from an isolated copy (git archive into .local/measure/<rev>, with a
// reflink copy of node_modules after checking that bun.lock is identical); the worktree is never
// checked out. A revision without the converter is reported as N/A. Budgets (decision 8): every
// warm sample <= 10,000 ms and peak RSS <= 1 GiB; with --baseline-median, the warm median must stay
// within 1.25x of it. Cold samples evict the fixture files from the page cache with
// posix_fadvise(DONTNEED) (no root needed) and are reported, not gated.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gitEnv } from '../browser-lock.mjs';
import { canonicalText } from '../../src/lib/case-package/canonical.ts';
import { parseStrictJson } from '../../src/lib/case-package/strict-json.ts';

const BunRt = (globalThis as { Bun?: { spawnSync: (cmd: string[], o?: object) => { exitCode: number; resourceUsage?: { maxRSS: number }; stderr?: Uint8Array } } }).Bun;
if (!BunRt) { console.error('run with bun'); process.exit(2); }

const { values } = parseArgs({ options: {
  ticket: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, samples: { type: 'string' }, warmup: { type: 'string' },
  cold: { type: 'string' }, 'baseline-median': { type: 'string' }, 'fixture-config': { type: 'string' }, out: { type: 'string' },
}, strict: true });
const repo = path.resolve(import.meta.dirname, '../..');
if (!values.ticket || !values.baseline || !values.candidate) { console.error('usage: measure.ts --ticket CC-02 --baseline REV --candidate REV [...]'); process.exit(2); }
const SAMPLES = Number(values.samples ?? 20);
const WARMUP = Number(values.warmup ?? 2);
const COLD = Number(values.cold ?? 3);
const BUDGET_MS = 10_000;
const BUDGET_RSS = 1024 ** 3;
const cfg = parseStrictJson(await readFile(path.resolve(repo, values['fixture-config'] ?? '.local/v5-verification.json'), 'utf8')) as any;
const outDir = path.resolve(values.out ?? path.join(repo, '.local/measure'));
const base = path.join(repo, '.local/measure');
await mkdir(outDir, { recursive: true });

const git = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() });
const resolveRev = (rev: string) => git(['rev-parse', '--verify', `${rev}^{commit}`]).stdout.trim();
const dirtyWorktree = git(['status', '--porcelain']).stdout.trim().length > 0;

/** Isolated copy of a revision, or null when it has no converter (N/A). */
async function isolate(rev: string): Promise<string | null> {
  if (git(['cat-file', '-e', `${rev}:scripts/case-package/cli.ts`]).status !== 0) return null;
  const dir = path.join(base, `rev-${rev.slice(0, 12)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tarFile = `${dir}.tar`;
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tarFile, rev], { env: gitEnv() });
  const untar = archive.status === 0 ? spawnSync('tar', ['-xf', tarFile, '-C', dir]) : archive;
  await rm(tarFile, { force: true });
  if (untar.status !== 0) throw new Error(`git archive ${rev} failed`);
  const lockHere = await readFile(path.join(repo, 'bun.lock'), 'utf8');
  const lockThere = await readFile(path.join(dir, 'bun.lock'), 'utf8').catch(() => '');
  if (lockHere === lockThere) spawnSync('cp', ['-r', '--reflink=auto', path.join(repo, 'node_modules'), path.join(dir, 'node_modules')]);
  else if (spawnSync(process.execPath, ['install', '--frozen-lockfile'], { cwd: dir }).status !== 0) throw new Error(`bun install failed for ${rev}`);
  return dir;
}

function evict(): void {
  // posix_fadvise(DONTNEED) drops clean cached pages of files we can read; no root, no writes
  spawnSync('python3', ['-I', '-c', `import os,sys
for root,_,files in os.walk(sys.argv[1]):
    for f in files:
        p=os.path.join(root,f)
        try:
            fd=os.open(p,os.O_RDONLY); os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED); os.close(fd)
        except OSError: pass`, cfg.caseFolder]);
}

interface Sample { ms: number; maxRssBytes: number; exit: number }
function sample(dir: string, tag: string): Sample {
  const out = path.join(base, `out-${tag}`);
  spawnSync('rm', ['-rf', out]);
  const t = performance.now();
  const r = BunRt!.spawnSync([process.execPath, path.join(dir, 'scripts/case-package/cli.ts'), 'convert', '--html', cfg.mainHtml.path, '--case-folder', cfg.caseFolder, '--case-id', cfg.caseId, '--out', out], { cwd: dir, stdout: 'ignore', stderr: 'pipe' });
  const ms = performance.now() - t;
  spawnSync('rm', ['-rf', out]);
  return { ms, maxRssBytes: r.resourceUsage?.maxRSS ?? -1, exit: r.exitCode };
}

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

const baseRev = resolveRev(values.baseline);
const candRev = resolveRev(values.candidate);
const baseDir = await isolate(baseRev);
const candDir = await isolate(candRev);
if (!candDir) { console.error(`candidate ${candRev} has no converter`); process.exit(1); }
const bunVersion = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim();

// warm-up (discarded): primes the page cache with the originals and Bun's transpiler cache
for (let i = 0; i < WARMUP; i++) { sample(candDir, 'warm'); if (baseDir) sample(baseDir, 'warm'); }
const cand: Sample[] = [];
const ref: Sample[] = [];
for (let i = 0; i < SAMPLES; i++) {
  cand.push(sample(candDir, 'cand'));
  if (baseDir) ref.push(sample(baseDir, 'base')); // alternate with an accepted Bun reference when one exists
}
const cold: Sample[] = [];
for (let i = 0; i < COLD; i++) { evict(); cold.push(sample(candDir, 'cold')); }

const ms = cand.map((s) => s.ms);
const rss = cand.map((s) => s.maxRssBytes);
const stats = (xs: Sample[]) => xs.length ? { medianMs: Math.round(median(xs.map((s) => s.ms))), p95Ms: Math.round(q(xs.map((s) => s.ms), 0.95)), maxMs: Math.round(Math.max(...xs.map((s) => s.ms))), medianRssMiB: +(median(xs.map((s) => s.maxRssBytes)) / 2 ** 20).toFixed(1), maxRssMiB: +(Math.max(...xs.map((s) => s.maxRssBytes)) / 2 ** 20).toFixed(1) } : null;
const fixed = values['baseline-median'] ? Number(values['baseline-median']) : null;
const checks = {
  allSamplesExit0: [...cand, ...cold].every((s) => s.exit === 0),
  everyWarmSampleWithin10000ms: Math.max(...ms) <= BUDGET_MS,
  peakRssMeasured: rss.every((b) => b > 0),
  peakRssWithin1GiB: rss.every((b) => b > 0) && Math.max(...rss) <= BUDGET_RSS,
  ...(fixed !== null && { medianWithin1_25xFixedBaseline: median(ms) <= 1.25 * fixed }),
};
const result = {
  ticket: values.ticket,
  workload: 'cli.ts convert: v5 main HTML + extracted case folder -> package directory, then importCandidate with full sha256 verification of every referenced original',
  command: `bun scripts/case-package/cli.ts convert --html <main HTML> --case-folder <tree> --case-id ${cfg.caseId} --out <tmp>`,
  baseline: { rev: baseRev, measured: baseDir !== null, note: baseDir ? 'accepted Bun reference, alternated with the candidate' : 'N/A: the base revision has no converter; the candidate is judged against the absolute budgets', stats: stats(ref) },
  candidate: { rev: candRev, worktreeDirty: dirtyWorktree, isolatedCopy: path.relative(repo, candDir), stats: stats(cand) },
  warmup: `${WARMUP} discarded run(s) per revision before sampling (page cache primed with the referenced originals)`,
  samples: SAMPLES,
  cacheMode: 'warm page cache',
  cold: { samples: COLD, method: 'posix_fadvise(POSIX_FADV_DONTNEED) on every file of the case folder before each run (no root; best effort, not a guaranteed drop)', stats: stats(cold) },
  budgets: { warmSampleMaxMs: BUDGET_MS, peakRssBytes: BUDGET_RSS, repeatMedianFactor: 1.25, fixedBaselineMedianMs: fixed },
  checks,
  pass: Object.values(checks).every(Boolean),
  fixture: { tree: cfg.caseFolder, mainHtmlSha256: cfg.mainHtml.sha256, archiveSha256: cfg.archive?.sha256 ?? null },
  machine: { host: os.hostname(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), kernel: os.release(), bun: bunVersion },
  rawMs: ms.map(Math.round),
  rawMaxRssMiB: rss.map((b) => +(b / 2 ** 20).toFixed(1)),
  rawColdMs: cold.map((s) => Math.round(s.ms)),
};
await writeFile(path.join(outDir, `measure-${values.ticket}.json`), canonicalText(result));
console.log(`base ${baseRev.slice(0, 12)}: ${baseDir ? JSON.stringify(stats(ref)) : 'N/A (no converter at this revision)'}`);
console.log(`candidate ${candRev.slice(0, 12)}${dirtyWorktree ? ' (worktree dirty; measured from the committed revision)' : ''}: ${JSON.stringify(stats(cand))}`);
console.log(`cold (fadvise DONTNEED): ${JSON.stringify(stats(cold))}`);
console.log(`checks: ${JSON.stringify(checks)}`);
console.log(`measure ${values.ticket}: ${result.pass ? 'PASS' : 'FAIL'} (${path.join(outDir, `measure-${values.ticket}.json`)})`);
for (const d of [baseDir, candDir]) if (d && existsSync(d)) await rm(d, { recursive: true, force: true });
process.exit(result.pass ? 0 : 1);
