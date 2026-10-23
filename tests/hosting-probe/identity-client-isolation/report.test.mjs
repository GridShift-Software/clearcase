import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finishRun } from './report.mjs';
import { artifacts } from './artifacts.mjs';

for (const kind of ['failed', 'interrupted', 'cleanup']) test(`${kind} run still scans logs and records a synthetic canary hit`, () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'grs201-report-'));
	try {
		mkdirSync(path.join(dir, 'logs'));
		const canary = 'synthetic-canary-only-grs201';
		writeFileSync(path.join(dir, 'logs/serve.log'), canary);
		const summary = { sourceSha: 'a'.repeat(40), treeClean: false, evidence: false, cleanup: {} };
		finishRun({ summary, dir, buildDir: path.join(dir, 'absent-build'), canaries: [canary], failure: { failed: kind === 'failed', interrupted: kind === 'interrupted', cleanupOkay: kind !== 'cleanup', stage: 'unit control' } });
		assert.equal(summary.evidence, false);
		assert.equal(summary.scan.hits, 1);
		assert.ok(summary.scan.manifest.some((f) => f.path === 'logs/serve.log'));
		assert.equal(JSON.parse(readFileSync(path.join(dir, 'failure.json'), 'utf8')).scanOkay, false);
		assert.ok(!readFileSync(path.join(dir, 'summary.json'), 'utf8').includes(canary));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
test('artifact hashes detect changed output bytes and exclude only final self-referencing reports', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'grs201-manifest-'));
	try {
		writeFileSync(path.join(dir, 'summary-scan.json'), '{}');
		writeFileSync(path.join(dir, 'summary.json'), '{}');
		const first = artifacts(dir, path.join(dir, 'absent-build'));
		assert.equal(first.length, 1);
		writeFileSync(path.join(dir, 'summary-scan.json'), '{"changed":true}');
		assert.notDeepEqual(artifacts(dir, path.join(dir, 'absent-build')), first);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const kind of ['metadata', 'snapshot-write', 'final-write']) test(`${kind} failure cannot bypass scanning existing logs`, () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'grs201-report-failure-'));
	try {
		const canary = 'synthetic-report-failure-canary';
		mkdirSync(path.join(dir, 'logs'));
		writeFileSync(path.join(dir, 'logs/serve.log'), canary);
		if (kind === 'snapshot-write') mkdirSync(path.join(dir, 'summary-scan.json'));
		if (kind === 'final-write') mkdirSync(path.join(dir, 'summary.json'));
		const summary = { sourceSha: 'a'.repeat(40), treeClean: false, evidence: false, cleanup: {} };
		finishRun({ summary, metadata: () => { if (kind === 'metadata') throw new Error('Git unavailable'); return {}; },
			dir, buildDir: path.join(dir, 'absent-build'), canaries: [canary], failure: { failed: false, interrupted: false, cleanupOkay: true, stage: 'reporting control' } });
		assert.equal(summary.scan.hits, 1);
		assert.equal(summary.evidence, false);
		assert.ok(summary.scan.manifest.some((f) => f.path === 'logs/serve.log'));
		assert.equal(JSON.parse(readFileSync(path.join(dir, 'failure.json'), 'utf8')).reportingOkay, false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
