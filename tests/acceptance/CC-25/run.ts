#!/usr/bin/env bun
// CC-25 (GRS-24) compatibility gate: one runner for the six acceptance items at the checked-out revision. Run it
// through scripts/agent-tools/receipt after `bun run --bun gate` has passed at the same HEAD:
//
//   scripts/agent-tools/receipt --name cc25-gate-runner --base <base> -- bun tests/acceptance/CC-25/run.ts \
//     --out .local/cc25/out --newer-case DIR --json-case DIR
//
// --newer-case is the newer 2,131-document export extracted under .local/ with Python's zipfile (not unzip: two
// originals have UTF-8 names); --json-case is the JSON-style data room's case folder. The v5 sample comes from
// .local/v5-verification.json. Each folder holds exactly one main workspace HTML. Real case material is read only;
// every step prints counts, key names, codes and states, never a document value. Steps and their items:
//
//   revision       HEAD, a clean tree, Bun 1.4.2, and no product file changed against --base (only this suite)
//   gate-v5        item 1: the gate's verify:pilot:v5 and strict parity summaries are passing evidence for HEAD: outcome, 42 views, strict register (cited, not re-run)
//   probe-v5       item 1: the v5 inventory in docs/compatibility.md, re-counted from the source and the package
//   probe-newer    item 2: 2,131 rows, every dataset accounted for, the storyline shape, refs reused against v5
//   probe-json     item 2: the JSON-style generation against its own inventory (4,466 rows, its own keys)
//   contract       item 3: one versioned package contract, identities, original mappings, diagnostics (real/contract.ts)
//   render-switch  items 3 and 5: every view of every generation rendered safely; notes across the v5-to-newer switch (real/render.ts)
//   synthetic      items 4 and 5: tests/acceptance/CC-25/*.test.ts (controlled data)
//
// Exit 0 when every step passes; the summary is <out>/summary.json and one line per step.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gitEnv } from '../../../scripts/browser-lock.mjs';
import { gateEvidenceProblems } from './gate-evidence.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const SUITE = ['tests/acceptance/CC-25', 'docs/acceptance/CC-25', 'docs/acceptance/fix-rounds', 'vitest.config.ts'];
const { values: a } = parseArgs({ options: {
  out: { type: 'string' }, 'newer-case': { type: 'string' }, 'json-case': { type: 'string' },
  base: { type: 'string', default: 'c6296f7a0de2ba3d7c6a832846ff6208436ee633' }, keep: { type: 'boolean', default: false },
} });
if (!a.out || !a['newer-case'] || !a['json-case']) { console.error('usage: run.ts --out DIR --newer-case DIR --json-case DIR [--base REV] [--keep]'); process.exit(2); }
const out = path.resolve(a.out);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const git = (...args: string[]) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', env: gitEnv() });
const head = git('rev-parse', 'HEAD').stdout.trim();
const locator = JSON.parse(readFileSync(path.join(REPO, '.local/v5-verification.json'), 'utf8')) as { caseFolder: string; mainHtml: { path: string } };
const mainHtml = (dir: string) => {
  const html = readdirSync(dir).filter((n) => /\.html?$/i.test(n) && !/\(.*\)/.test(n));
  if (html.length !== 1) throw new Error(`expected one main workspace HTML in the case folder, found ${html.length}`);
  return path.join(dir, html[0]!);
};
const gens = {
  v5: { html: locator.mainHtml.path, caseFolder: locator.caseFolder, caseId: 'cc25-real', expect: 'v5' },
  newer: { html: mainHtml(a['newer-case']), caseFolder: path.resolve(a['newer-case']), caseId: 'cc25-real', expect: 'ess-newer' },
  json: { html: mainHtml(a['json-case']), caseFolder: path.resolve(a['json-case']), caseId: 'cc25-json', expect: 'json-room' },
};
const pkg = (g: keyof typeof gens) => path.join(out, `pkg-${g}`);

type Step = { step: string; items: number[]; status: 'PASS' | 'FAIL'; exit: number | null; ms: number; log?: string; facts?: unknown; problems?: string[] };
const steps: Step[] = [];
function record(step: string, items: number[], t0: number, problems: string[], exit: number | null, facts?: unknown, log?: string) {
  const s: Step = { step, items, status: problems.length ? 'FAIL' : 'PASS', exit, ms: Math.round(performance.now() - t0), log, facts, problems };
  steps.push(s);
  console.log(`${s.status} ${step} (items ${items.join(', ')}; exit ${exit ?? '-'}; ${s.ms} ms)${problems.length ? ': ' + problems.join('; ') : ''}`);
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ suite: 'CC-25', head, base: a.base, partial: true, steps }, null, 1));
}
/** Run a command with its output in <out>/<name>.log; returns its exit code and output. */
function run(name: string, cmd: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 2 ** 20 });
  const log = path.join(out, `${name}.log`);
  writeFileSync(log, (r.stdout ?? '') + (r.stderr ? `\n--- stderr\n${r.stderr}` : ''));
  return { exit: r.status, stdout: r.stdout ?? '', log: path.relative(REPO, log) };
}

// revision: what is under test, and that it is the base's product code
{
  const t0 = performance.now();
  const problems: string[] = [];
  if (process.versions.bun !== '1.4.2') problems.push(`Bun ${process.versions.bun}, not 1.4.2`);
  const dirty = git('status', '--porcelain', '--untracked-files=all').stdout.trim();
  if (dirty) problems.push(`the tree is not clean (${dirty.split('\n').length} paths)`);
  const diff = git('diff', '--name-only', a.base!, head);
  if (diff.status !== 0) problems.push(`git diff ${a.base} ${head.slice(0, 12)} failed (${diff.status}): the base is not a revision of this checkout`);
  const changed = diff.stdout.trim().split('\n').filter(Boolean);
  const product = changed.filter((f) => !SUITE.some((s) => f === s || f.startsWith(s + '/')));
  if (product.length) problems.push(`product files differ from the base: ${product.join(', ')}`);
  const cfg = git('diff', '-U0', a.base!, head, '--', 'vitest.config.ts').stdout.split('\n').filter((l) => /^[+-][^+-]/.test(l));
  if (cfg.some((l) => !l.startsWith('+') || !l.includes('tests/acceptance/CC-25/'))) problems.push('vitest.config.ts changes more than the CC-25 include line');
  record('revision', [], t0, problems, null, { head, base: a.base, bun: process.versions.bun, changedFiles: changed.length });
}

// item 1: the gate's own v5 evidence for this HEAD, read the way the gate reads it
{
  const t0 = performance.now();
  const problems: string[] = [];
  const facts: Record<string, unknown> = {};
  for (const [name, file] of [['verify:pilot:v5', '.local/gate/v5-out/lanes-v5.json'], ['parity --all --strict-register', '.local/gate/parity-out/scorecard.json']] as const) {
    const p = path.join(REPO, file);
    if (!existsSync(p)) { problems.push(`${name}: no gate summary at ${file}; run bun run --bun gate at this HEAD first`); continue; }
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    problems.push(...gateEvidenceProblems(name, doc, head));
    facts[name] = { file, evidence: doc.evidence, ok: doc.ok ?? null, result: doc.result ?? null, exit: doc.exit ?? null, views: doc.total?.views ?? null, strictRegister: doc.register?.strict ?? null, head: doc.freshBuild?.head ?? null };
  }
  record('gate-v5', [1], t0, problems, null, facts);
}

// items 1 and 2: the GRS-22 probe for each generation against the inventory recorded in docs/compatibility.md
const probes: Record<string, any> = {};
for (const g of ['v5', 'newer', 'json'] as const) {
  const t0 = performance.now();
  const x = gens[g];
  const args = ['tests/case-package/compat/probe.ts', '--html', x.html, '--case-folder', x.caseFolder, '--case-id', x.caseId, '--expect', x.expect, '--out', pkg(g)];
  if (g === 'newer') args.push('--compare-with', pkg('v5'));
  const r = run(`probe-${g}`, [process.execPath, ...args]);
  const problems: string[] = [];
  if (r.exit !== 0) problems.push(`probe exit ${r.exit}: ${r.stdout.trim().split('\n').pop()}`);
  let doc: any = null;
  try { doc = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('\n}') + 2)); } catch { problems.push('probe output does not parse'); }
  probes[g] = doc;
  const res = doc?.result ?? {};
  const want = { v5: { documents: 1689 }, newer: { documents: 2131, storyline: 6, strategy: 6 }, json: { documents: 4466, storyline: 29 } }[g];
  if (res.documents !== want.documents) problems.push(`documents ${res.documents}, expected ${want.documents}`);
  if (doc && (doc.result.unaccounted?.length ?? 1) !== 0) problems.push(`unaccounted datasets: ${doc.result.unaccounted}`);
  if ('storyline' in want && res.matterHeadings?.storyline !== want.storyline) problems.push(`storyline headings ${res.matterHeadings?.storyline}, expected ${want.storyline}`);
  if ('strategy' in want && res.matterHeadings?.strategy !== want.strategy) problems.push(`strategy headings ${res.matterHeadings?.strategy}, expected ${want.strategy}`);
  if (g === 'newer' && doc?.refReuse?.followedTheRef !== 0) problems.push(`an anchor followed a reused ref (${doc?.refReuse?.followedTheRef})`);
  if (g === 'newer' && JSON.stringify(Object.keys(doc?.inventory?.analysisOverlay ?? {}).length) !== '19') problems.push('the analysis overlay is not the 19-key dataset');
  record(`probe-${g}`, g === 'v5' ? [1] : [2], t0, problems, r.exit, doc && {
    expect: doc.expect, inventory: doc.inventory, states: res.states, residual: res.residual, demoted: res.demoted, documents: res.documents, verdict: res.verdict,
    matterHeadings: res.matterHeadings, riskFields: res.riskFields, assets: res.assets, packageFiles: res.packageFiles, refReuse: doc.refReuse ?? null,
    accounted: (doc.account as { source: string; state: string; datasets: string[] }[]).map((x) => `${x.source} ${x.state}`), ms: res.ms, rssMiB: res.rssMiB,
  }, r.log);
}

// item 3: the package contract across the three real packages
{
  const t0 = performance.now();
  const spec = (g: keyof typeof gens) => `${g}=${pkg(g)}=${gens[g].caseFolder}=${gens[g].html}`;
  const r = run('contract', [process.execPath, 'tests/acceptance/CC-25/real/contract.ts', spec('v5'), spec('newer'), spec('json')]);
  let facts: any = null;
  try { facts = JSON.parse(readFileSync(path.join(out, 'contract.json'), 'utf8')); } catch { /* reported below */ }
  record('contract', [3], t0, r.exit === 0 ? [] : [`exit ${r.exit}: ${r.stdout.trim().split('\n').pop()}`], r.exit, facts, r.log);
}

// items 3 and 5: the real packages through the app: every view rendered, and notes across the v5-to-newer switch
{
  const t0 = performance.now();
  const r = run('render-switch', [process.execPath, 'tests/acceptance/CC-25/real/render.ts', '--out', out,
    '--v5', `${pkg('v5')}=${gens.v5.caseFolder}`, '--newer', `${pkg('newer')}=${gens.newer.caseFolder}`, '--json', `${pkg('json')}=${gens.json.caseFolder}`]);
  let facts: any = null;
  try { facts = JSON.parse(readFileSync(path.join(out, 'render.json'), 'utf8')); } catch { /* reported below */ }
  record('render-switch', [3, 5], t0, r.exit === 0 ? [] : [`exit ${r.exit}: ${r.stdout.trim().split('\n').pop()}`], r.exit, facts, r.log);
}

// items 4 and 5: the controlled synthetic cases
{
  const t0 = performance.now();
  const r = run('synthetic', [process.execPath, 'run', '--bun', 'vitest', 'run', 'tests/acceptance/CC-25/']);
  const tally = /Tests\s+(.*)\n/.exec(r.stdout.replace(/\x1b\[[0-9;]*m/g, ''))?.[1]?.trim() ?? null;
  record('synthetic', [4, 5], t0, r.exit === 0 ? [] : [`vitest exit ${r.exit}: ${tally}`], r.exit, { tests: tally }, r.log);
}

if (!a.keep) for (const g of ['v5', 'newer', 'json'] as const) rmSync(pkg(g), { recursive: true, force: true });
rmSync(path.join(out, 'data'), { recursive: true, force: true });
const failed = steps.filter((s) => s.status === 'FAIL').map((s) => s.step);
writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ suite: 'CC-25', head, base: a.base, partial: false, verdict: failed.length ? 'FAIL' : 'PASS', steps }, null, 1));
console.log(failed.length ? `CC-25 FAIL ${failed.join(', ')} at ${head}` : `CC-25 PASS ${steps.length} steps at ${head}`);
process.exit(failed.length ? 1 : 0);
