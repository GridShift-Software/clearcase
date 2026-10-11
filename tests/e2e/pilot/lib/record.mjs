// Result recording for the e2e runners: every scenario ends PASS or FAIL with evidence; an exception is a FAIL, and
// a scenario that cannot run is SKIPPED, which also fails the run. Results go to <out>/<name>.json, with `extra` from
// finish() (an aborted run's `aborted` and `evidence: false`).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const outDir = () => process.env.CLEARCASE_E2E_OUT ?? join(process.env.CLEARCASE_REPORT_DIR ?? join(process.cwd(), '.local'), 'e2e');

export function recorder(name, meta = {}) {
	const results = [];
	const t0 = Date.now();
	const rec = (id, title, status, evidence = {}) => {
		results.push({ id, title, status, evidence });
		console.log(`${status.padEnd(7)} ${id} ${title}`);
		return status === 'PASS';
	};
	const step = async (id, title, fn) => {
		try { const r = await fn(); if (typeof r === 'boolean') rec(id, title, r ? 'PASS' : 'FAIL'); else if (r && typeof r === 'object' && 'pass' in r) rec(id, title, r.pass ? 'PASS' : 'FAIL', r.evidence ?? r); }
		catch (e) { rec(id, title, 'FAIL', { error: String(e?.stack ?? e).slice(0, 4000) }); }
	};
	const finish = (extra = {}) => {
		const dir = outDir();
		mkdirSync(dir, { recursive: true });
		const counts = Object.fromEntries(['PASS', 'FAIL', 'SKIPPED'].map((s) => [s, results.filter((r) => r.status === s).length]));
		const ok = counts.FAIL === 0 && counts.SKIPPED === 0 && results.length > 0;
		writeFileSync(join(dir, `${name}.json`), JSON.stringify({ name, ...meta, ...extra, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, counts, ok, results }, null, 1));
		console.log(`${name}: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SKIPPED} SKIPPED -> ${join(dir, `${name}.json`)}`);
		return ok;
	};
	return { results, rec, step, finish };
}
