// The journey probes (GRS-266): each journey runs, through its own entry point, against the synthetic app in probes/app.mjs.
// On the healthy app every probed journey must pass; on each broken scenario it must fail at exactly the steps named, so a check
// that lets that markup through again shows as a FALSE PASS. Offline: loopback only, no case data, no sign-in.
//   bun tests/journeys/probes/run.mjs [--journeys <dir holding J1.mjs ...>] [finding ...]
// --journeys runs another revision's journeys (a detached worktree of an older commit) against the same probes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve, CASE, RV, SHA, REFS } from './app.mjs';

const PROBES = [
  ...['J1', 'J2', 'J3', 'J4', 'J5'].map(journey => ({ finding: `control:${journey}`, journey, scenario: 'healthy', fails: [] })),
  { finding: 'H1', journey: 'J1', scenario: 'h1', fails: ['nav:matter', 'nav:people', 'nav:contracts_tab'] },
  { finding: 'H2', journey: 'J2', scenario: 'h2', fails: ['overview-content', 'journey'] },
  { finding: 'H3', journey: 'J5', scenario: 'h3', fails: ['contracts_tab'] },
  { finding: 'H4', journey: 'J4', scenario: 'h4', fails: ['small:first-pdf-page', 'small', 'medium:first-pdf-page', 'medium'] },
  { finding: 'H5', journey: 'J3', scenario: 'h5', fails: ['network/runtime'] },
  { finding: 'H6', journey: 'J3', scenario: 'h6', fails: ['one-click-row-original', 'pane-original', 'phone-pane-original'] },
  { finding: 'M1', journey: 'J3', scenario: 'm1', fails: ['one-click-row-original'] },
  { finding: 'M2', journey: 'J5', scenario: 'm2', fails: ['heads_tab'] },
  { finding: 'M3', journey: 'J3', scenario: 'm3', fails: ['phone-headings', 'phone-pane-original'] },
  // PR #206 review round: placeholder rows, hidden slot text, the phone leg of M1 and an expected Heads count.
  { finding: 'H1-placeholder', journey: 'J1', scenario: 'h1-placeholder', fails: ['nav:people'] },
  { finding: 'H2-hidden-text', journey: 'J2', scenario: 'h2-hidden-text', fails: ['overview-content', 'journey'] },
  { finding: 'H3-placeholder', journey: 'J5', scenario: 'h3-placeholder', fails: ['contracts_tab'] },
  { finding: 'M1-phone', journey: 'J3', scenario: 'm1-phone', fails: ['phone-pane-original'] },
  { finding: 'M2-expected', journey: 'J5', scenario: 'healthy', env: { HEADS_EXPECTED: '2' }, fails: ['heads_tab'] },
  // GRS-273: a scan's page 1 marked rendered over a blank canvas, in the chronology pane (desktop and phone) and the opened original.
  { finding: 'B1', journey: 'J3', scenario: 'blank-canvas', fails: ['one-click-row-original', 'pane-original', 'phone-pane-original'] },
  { finding: 'B1-J4', journey: 'J4', scenario: 'blank-canvas', fails: ['small:first-pdf-page', 'small', 'medium:first-pdf-page', 'medium'] },
  { finding: 'control:J5-heads0', journey: 'J5', scenario: 'healthy', env: { HEADS_EXPECTED: '0' }, fails: [] },
  { finding: 'control:J5-heads2', journey: 'J5', scenario: 'heads-seeded', env: { HEADS_EXPECTED: '2' }, fails: [] },
];

const args = process.argv.slice(2);
const at = args.indexOf('--journeys');
const journeys = path.resolve(at >= 0 ? args.splice(at, 2)[1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const only = new Set(args);
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'journey-probes-'));
// Only what a journey needs: the probe app's identity, and the host's browser and lock settings. No staging value reaches it.
const PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'CHROMIUM_PATH', 'CLEARCASE_BROWSER_LOCK', 'CLEARCASE_BROWSER_SLOT'];
const rows = [];
for (const probe of PROBES.filter(p => !only.size || only.has(p.finding) || only.has(p.finding.split(':')[0]))) {
  const app = await serve(probe.scenario);
  const env = {
    ...Object.fromEntries(PASS_THROUGH.filter(n => process.env[n]).map(n => [n, process.env[n]])),
    MODE: 'hosted', BASE_URL: app.origin, CASE_ID: CASE, RESULTS_VERSION: RV, EXPECTED_SHA: SHA, EXPECTED_DOCUMENTS: '3',
    SMALL_REF: REFS[0], MEDIUM_REF: REFS[1], LARGE_REF: REFS[2], RESULTS_DIR: path.join(out, probe.finding.replace(':', '-')),
    ...probe.env,
  };
  try {
    await new Promise(resolve => spawn(process.execPath, [path.join(journeys, `${probe.journey}.mjs`)], { env, stdio: 'ignore' }).on('exit', resolve));
  } finally { await app.close(); }
  let result;
  try { result = JSON.parse(await fs.readFile(path.join(env.RESULTS_DIR, `${probe.journey}.json`), 'utf8')); }
  catch { result = { status: 'NO RESULT', steps: [] }; }
  const failed = result.steps.filter(s => s.status === 'FAIL').map(s => s.name);
  const exact = failed.length === probe.fails.length && probe.fails.every(f => failed.includes(f));
  const verdict = probe.fails.length
    ? (result.status === 'PASS' ? 'FALSE PASS' : result.status === 'FAIL' && exact ? 'caught' : 'WRONG STEPS')
    : (result.status === 'PASS' ? 'passes' : 'HEALTHY APP FAILS');
  rows.push({ ...probe, status: result.status, failed, verdict, reasons: result.steps.filter(s => s.status === 'FAIL').map(s => `${s.name}: ${s.reason}`) });
  console.log(`${probe.finding.padEnd(17)} ${probe.journey}  ${result.status.padEnd(4)}  ${verdict.padEnd(17)} failed: ${failed.join(', ') || '-'}`);
}
for (const r of rows.filter(r => !['caught', 'passes'].includes(r.verdict))) console.log(`\n${r.finding}: expected failing [${r.fails.join(', ')}]\n  ${r.reasons.join('\n  ') || 'no failed step'}`);
await fs.rm(out, { recursive: true, force: true });
process.exitCode = rows.every(r => ['caught', 'passes'].includes(r.verdict)) ? 0 : 1;
