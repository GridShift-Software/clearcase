import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, OUT, NEEDS, preflightProblems, refuse } from './lib.mjs';
// Every journey needs the case's references, so a missing one stops the run here, before the first browser starts.
const problems = preflightProblems(NEEDS.samples);
if (problems.length) { refuse(problems); process.exit(2); }
await fs.mkdir(OUT, { recursive: true });
const results = [];
const runId = new Date().toISOString().replace(/[:.]/g, '-');
for (let i = 1; i <= 10; i++) {
  const id = `J${i}`;
  // A fresh process/context per journey; failures never prevent the remaining journeys.
  const file = path.join(OUT, `${id}.json`); await fs.rm(file, { force: true });
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, `${id}.mjs`)], { stdio: 'inherit', env: { ...process.env, RUN_ID: runId } });
    child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1));
  });
  let result;
  try { result = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { result = { id, status: 'FAIL', steps: [{ name: 'runner', status: 'FAIL', reason: 'No result produced' }] }; }
  if (exitCode !== 0) result.status = 'FAIL';
  results.push(result);
  await fs.writeFile(path.join(OUT, 'summary.json'), JSON.stringify({ runId, results }, null, 2));
}
// A SKIPPED journey (a write journey under READ_ONLY=1) or a PARTIAL one (steps skipped, none failed) is never counted as a pass.
const cell = r => r.status === 'SKIPPED' ? `SKIPPED (${r.reason})` : r.status;
const skipped = r => r.steps.filter(s => s.status === 'SKIPPED').map(s => s.name).join(', ');
const table = ['| Journey | Result | Timings (ms) | Failed checks | Skipped steps |', '|---|---|---|---|---|', ...results.map(r => `| ${r.id} | ${cell(r)} | ${r.steps.filter(s => s.ms !== undefined).map(s => `${s.name}: ${s.ms}`).join('; ')} | ${r.steps.filter(s => s.status === 'FAIL').map(s => `${s.name}: ${s.reason}`).join('; ')} | ${skipped(r)} |`)].join('\n');
const count = status => results.filter(r => r.status === status).length;
const tally = `PASS ${count('PASS')} · FAIL ${count('FAIL')} · PARTIAL ${count('PARTIAL')} · SKIPPED ${count('SKIPPED')}`;
await fs.writeFile(path.join(OUT, 'summary.md'), `${table}\n\n${tally}\n`);
console.log(`${table}\n\n${tally}`);
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
