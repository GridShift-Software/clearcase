import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, createHarness, scope } from './pc1-vm-support';

const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { afterEach, test }: Pick<typeof import('vitest'), 'afterEach' | 'test'> = await import(testRunner);
const { fixture, cleanup } = createHarness();
afterEach(cleanup);


test('verdict returns UNKNOWN and exit 2 for a miss without needing a local commit or changing runner state', () => {
  const f = fixture();
  const sha = 'a'.repeat(40);
  const result = f.run('verdict', sha);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, `UNKNOWN ${sha}\n`);
  assert.deepEqual(f.events(), []);
});


test('verdict reads GitHub run keys and ignores an unfinished or mismatched result', () => {
  const f = fixture();
  const completed = path.join(f.store, `${f.sha}-123-1`);
  const unfinished = path.join(f.store, `${f.sha}-verify-pending`);
  const wrong = path.join(f.store, `${f.sha}-124-1`);
  for (const entry of [completed, unfinished, wrong]) mkdirSync(entry, { recursive: true });
  writeFileSync(path.join(completed, 'verdict.txt'), `PASS ${f.sha}\n`);
  writeFileSync(path.join(wrong, 'verdict.txt'), `PASS ${'b'.repeat(40)}\n`);
  const result = f.run('verdict', f.sha);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `PASS ${f.sha}\nreceipts ${completed}\n${scope}\n`);
  assert.deepEqual(f.events(), []);
});


test('verdict selects the latest completed attempt for the same SHA, including FAIL after PASS', () => {
  const f = fixture();
  assert.equal(f.run('verify', 'HEAD').status, 0);
  writeFileSync(path.join(f.guest, 'scenario'), 'test-fail');
  assert.equal(f.run('verify', 'HEAD').status, 1);
  assert.equal(f.results().length, 2);
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 1, verdict.stderr);
  assert.match(verdict.stdout, new RegExp(`^FAIL ${f.sha}$`, 'm'));
});


test('verdict returns UNKNOWN when the store contains only incomplete entries', () => {
  const f = fixture();
  mkdirSync(path.join(f.store, `${f.sha}-verify-incomplete`), { recursive: true });
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 2, verdict.stderr);
  assert.equal(verdict.stdout, `UNKNOWN ${f.sha}\n`);
});


test('the workflow store step copies receipts and records merge and PR head SHAs separately', () => {
  const f = fixture();
  const workflow = readFileSync(path.join(app, '.github/workflows/ci.yml'), 'utf8');
  const step = workflow.split('      - name: store verdict\n')[1]?.split('      - if: always()\n')[0];
  assert.ok(step);
  const block = step.split('        run: |\n')[1];
  assert.ok(block);
  const script = block.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const receipts = path.join(f.guest, 'temp/receipts');
  mkdirSync(path.join(receipts, 'receipt-check'), { recursive: true });
  writeFileSync(path.join(receipts, 'receipt-check/receipt.json'), '{"result":"PASS"}\n');
  writeFileSync(path.join(receipts, 'receipt-check/stdout.txt'), 'synthetic private output\n');
  writeFileSync(path.join(receipts, 'receipt-check/stderr.txt'), 'synthetic private error\n');
  writeFileSync(path.join(receipts, 'summary.md'), '# Synthetic summary\n');
  writeFileSync(path.join(receipts, 'summary.json'), JSON.stringify({ head: f.sha, verdict: 'PASS' }));
  const prHead = 'b'.repeat(40);
  for (const [attempt, status, expected] of [['1', 'success', 'PASS'], ['2', 'failure', 'FAIL'], ['3', 'cancelled', 'FAIL']]) {
    const result = spawnSync('bash', ['-c', script], { cwd: f.source, env: { ...f.env, GITHUB_SHA: f.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: attempt, PR_HEAD_SHA: prHead, JOB_STATUS: status, RUNNER_TEMP: path.dirname(receipts) }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const target = path.join(f.store, `${f.sha}-123-${attempt}`);
    assert.equal(readFileSync(path.join(target, 'verdict.txt'), 'utf8'), `${expected} ${f.sha}\n`);
    assert.equal(readFileSync(path.join(target, 'receipt-check/receipt.json'), 'utf8'), '{"result":"PASS"}\n');
    assert.equal(readFileSync(path.join(target, 'summary.md'), 'utf8'), '# Synthetic summary\n');
    assert.equal(existsSync(path.join(target, 'receipt-check/stdout.txt')), false);
    assert.equal(existsSync(path.join(target, 'receipt-check/stderr.txt')), false);
    const metadata = readFileSync(path.join(target, 'run-metadata.json'), 'utf8');
    assert.match(metadata, new RegExp(`"GITHUB_SHA": "${f.sha}"`));
    assert.match(metadata, new RegExp(`"PR_HEAD_SHA": "${prHead}"`));
  }
  for (const [attempt, summary] of [['4', '{}'], ['5', '[]'], ['6', JSON.stringify({ head: prHead, verdict: 'PASS' })], ['7', 'invalid JSON']]) {
    writeFileSync(path.join(receipts, 'summary.json'), summary);
    const result = spawnSync('bash', ['-c', script], { cwd: f.source, env: { ...f.env, GITHUB_SHA: f.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: attempt, PR_HEAD_SHA: prHead, JOB_STATUS: 'success', RUNNER_TEMP: path.dirname(receipts) }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(readFileSync(path.join(f.store, `${f.sha}-123-${attempt}`, 'verdict.txt'), 'utf8'), `FAIL ${f.sha}\n`);
  }
});


for (const link of ['entry', 'verdict', 'root']) {
  test(`verdict rejects a symlinked ${link} without accepting an external PASS`, () => {
    const f = fixture();
    const outside = path.join(f.guest, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'verdict.txt'), `PASS ${f.sha}\n`);
    const entry = path.join(f.store, `${f.sha}-123-1`);
    if (link === 'root') {
      mkdirSync(path.join(outside, `${f.sha}-123-1`));
      writeFileSync(path.join(outside, `${f.sha}-123-1/verdict.txt`), `PASS ${f.sha}\n`);
      symlinkSync(outside, f.store);
    } else {
      mkdirSync(f.store, { recursive: true });
      if (link === 'entry') symlinkSync(outside, entry);
      else {
        mkdirSync(entry);
        symlinkSync(path.join(outside, 'verdict.txt'), path.join(entry, 'verdict.txt'));
      }
    }
    const result = f.run('verdict', f.sha);
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.equal(result.stdout, `UNKNOWN ${f.sha}\n`);
    assert.match(result.stderr, /unsafe.*store|symlink|outside/);
    assert.deepEqual(f.events(), []);
  });
}


for (const link of ['receipt', 'directory', 'summary', 'root', 'stdout', 'fifo']) {
  test(`workflow store rejects a symlinked ${link} and publishes no verdict`, () => {
    const f = fixture();
    const workflow = readFileSync(path.join(app, '.github/workflows/ci.yml'), 'utf8');
    const block = workflow.split('      - name: store verdict\n')[1]?.split('      - if: always()\n')[0]?.split('        run: |\n')[1];
    assert.ok(block);
    const script = block.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const outside = path.join(f.guest, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'receipt.json'), '{"synthetic":"private"}\n');
    const receipts = path.join(f.guest, 'temp/receipts');
    mkdirSync(path.dirname(receipts), { recursive: true });
    if (link === 'root') symlinkSync(outside, receipts);
    else {
      mkdirSync(receipts);
      writeFileSync(path.join(receipts, 'summary.json'), JSON.stringify({ head: f.sha, verdict: 'PASS' }));
      if (link === 'directory') symlinkSync(outside, path.join(receipts, 'receipt-check'));
      else if (link === 'summary') {
        rmSync(path.join(receipts, 'summary.json'));
        symlinkSync(path.join(outside, 'receipt.json'), path.join(receipts, 'summary.json'));
      } else {
        mkdirSync(path.join(receipts, 'receipt-check'));
        const incoming = path.join(receipts, 'receipt-check', link === 'stdout' ? 'stdout.txt' : 'receipt.json');
        if (link === 'fifo') execFileSync('mkfifo', [incoming]);
        else symlinkSync(path.join(outside, 'receipt.json'), incoming);
      }
    }
    const result = spawnSync('bash', ['-c', script], { cwd: f.source, env: { ...f.env, GITHUB_SHA: f.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', JOB_STATUS: 'success', RUNNER_TEMP: path.dirname(receipts) }, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /symlink|unsafe|outside/);
    assert.equal(existsSync(path.join(f.store, `${f.sha}-123-1`)), false);
    assert.deepEqual(readdirSync(f.store), []);
  });
}
