import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweep } from './scenario.mjs';
import { transcript } from './transcript.mjs';
import { finishRun } from './report.mjs';

test('failed sweep retains completed and failed safe observations in the scanned report', async () => {
	const rows = transcript();
	const bodyCanary = 'synthetic-private-response-body';
	const tokenCanary = 'synthetic-private-request-token';
	let requests = 0;
	const server = createServer((_req, res) => {
		requests++;
		res.writeHead(requests === 1 ? 200 : 503);
		res.end(requests === 1 ? rows[0].marker : bodyCanary);
	});
	const dir = mkdtempSync(path.join(tmpdir(), 'grs201-sweep-failure-'));
	try {
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const progress = { results: [], storesUnchanged: {} };
		const world = { origin: `http://127.0.0.1:${server.address().port}`, token: async () => tokenCanary, snapshot: async () => 'unchanged' };
		await assert.rejects(sweep({ a: world, c: world }, progress), /request contract failed/);
		assert.equal(requests, 2);
		assert.equal(progress.results.length, 2);
		assert.equal(progress.results[0].pass, true);
		assert.equal(progress.results[1].command, rows[1].command);
		assert.equal(progress.results[1].status, 200);
		assert.deepEqual(progress.results[1].observed, { status: 503, denial: null, marker: false, leaked: false });
		assert.equal(progress.results[1].pass, false);
		const summary = { sourceSha: 'a'.repeat(40), treeClean: false, cleanup: {}, ...progress, evidence: false };
		finishRun({ summary, dir, buildDir: path.join(dir, 'absent-build'), canaries: [bodyCanary, tokenCanary],
			failure: { failed: true, interrupted: false, cleanupOkay: true, stage: 'reciprocal request sweep' } });
		const written = readFileSync(path.join(dir, 'summary.json'), 'utf8');
		assert.deepEqual(JSON.parse(written).results, progress.results);
		assert.equal(JSON.parse(written).evidence, false);
		assert.equal(summary.scan.hits, 0);
		assert.ok(!written.includes(bodyCanary) && !written.includes(tokenCanary));
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});
