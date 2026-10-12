// GRS-20 (CC-10) measurement: the budgets in tests/system/budgets.json, on the synthetic fixture they name, under Bun.
//   bun run --bun tests/system/measure.ts            measure; exit 1 on a breach or on an unchanged quick scan slower
//                                                     than regressionFactor x the recorded median
//   bun run --bun tests/system/measure.ts --record   also record the unchanged quick scan's median run as the baseline
// Peak memory is the process's peak resident set (resourceUsage().maxRSS) after the workload minus the resident set
// before it. Prints one JSON summary; writes nothing else.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCase, putOriginal } from '../e2e/pilot/lib/fixtures.ts';
import { rescan } from '../../src/lib/local-case/rescan/rescan.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';
import { createBackup, restoreBackup } from '../../src/lib/user-work/backup/backup.server.ts';

const BUDGETS = path.join(import.meta.dirname, 'budgets.json');
const budgets = JSON.parse(readFileSync(BUDGETS, 'utf8'));
const record = process.argv.includes('--record');
const MiB = 1024 * 1024;
const rss = () => process.memoryUsage().rss;
const peak = () => process.resourceUsage().maxRSS * 1024;

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; ms: number; peakMiB: number }> {
	const before = rss();
	const t0 = performance.now();
	const value = await fn();
	const ms = performance.now() - t0;
	return { value, ms: Math.round(ms * 10) / 10, peakMiB: Math.round(((peak() - before) / MiB) * 10) / 10 };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const root = await tempRoot('cc10-measure');
const lc = service(path.join(root, 'data'));
try {
	await lc.startup();
	const caseId = 'measure-case';
	const built = await buildCase(path.join(root, 'case'), { caseId });
	const imported = await lc.importPackage(built.caseDir, built.pkgDir);
	const refused = await lc.activate(built.resultsVersion, ackFor(lc, imported.importId!));
	if (refused) throw new Error(`activation refused: ${JSON.stringify(refused)}`);
	const rv = built.resultsVersion;

	// the fixture budgets.json names: 40 additions in the case folder, 5,000 register rows over 7 stores, 1,000 notes
	// and one defined table of 1,000 rows
	for (let i = 0; i < 40; i++) await putOriginal(built.caseDir, `DISCOVERY A/OD-${String(100 + i).padStart(3, '0')} Added ${i}.pdf`, new TextEncoder().encode(`%PDF-1.4 synthetic ${i}`));
	const stores = ['deadlines', 'timesheet', 'privilege-log', 'issues', 'witnesses', 'tasks', 'costs'];
	for (let i = 0; i < 5000; i++) await lc.userWork.putRow(caseId, stores[i % stores.length], null, { title: `synthetic row ${i}`, n: i, done: i % 2 === 0 });
	for (let i = 0; i < 1000; i++) await lc.userWork.addNote(caseId, rv, `OD-00${(i % 4) + 1}`, `synthetic note ${i}`);
	await lc.userWork.defineTable({ name: 'measure_marks', owner: 'TEST', scope: 'case', description: 'synthetic', columns: [{ name: 'case_id', type: 'TEXT', notNull: true }, { name: 'k', type: 'TEXT', notNull: true }, { name: 'n', type: 'INTEGER' }], primaryKey: ['case_id', 'k'] });
	for (let i = 0; i < 1000; i++) await lc.userWork.putTableRow('measure_marks', { case_id: caseId, k: `k${i}`, n: i }, { owner: 'TEST' });

	const first = await rescan(lc, rv, 'quick');
	const quick: number[] = [];
	const { runs, scansPerRun } = budgets.rescan.unchangedQuickScan;
	for (let i = 0; i < runs; i++) quick.push((await timed(async () => { for (let j = 0; j < scansPerRun; j++) await rescan(lc, rv, 'quick'); })).ms);
	const full = await timed(() => rescan(lc, rv, 'full'));

	const backup = await timed(() => JSON.stringify(createBackup(lc, rv)));
	const text = backup.value;
	const restore = await timed(() => restoreBackup(lc, text, { caseId, resultsVersion: rv }));

	const baseline = budgets.rescan.unchangedQuickScan;
	const quickMedian = median(quick);
	// only the baseline's value changes, so the file keeps its layout
	if (record) { baseline.baselineMedianMs = quickMedian; writeFileSync(BUDGETS, readFileSync(BUDGETS, 'utf8').replace(/"baselineMedianMs": [\d.a-z]+/, `"baselineMedianMs": ${quickMedian}`)); }
	const limit = baseline.baselineMedianMs === null ? null : Math.round(baseline.baselineMedianMs * baseline.regressionFactor * 10) / 10;
	const fileMiB = Math.round((Buffer.byteLength(text) / MiB) * 100) / 100;
	const checks = {
		additions: first.counts.added === 40,
		unchangedQuickScan: limit !== null && quickMedian <= limit,
		fullScan: full.ms <= budgets.rescan.fullScanMaxMs,
		backupMs: backup.ms <= budgets.backup.maxMs,
		backupPeak: backup.peakMiB <= budgets.backup.maxPeakRssMiB,
		restoreMs: restore.ms <= budgets.restore.maxMs,
		restorePeak: restore.peakMiB <= budgets.restore.maxPeakRssMiB,
		restoreFile: fileMiB <= budgets.restore.maxFileMiB,
	};
	const ok = Object.values(checks).every(Boolean);
	console.log(JSON.stringify({ ok, runtime: `bun ${process.versions.bun ?? '(not Bun)'}`, recorded: record, rescan: { added: first.counts.added, quickMs: quick, quickMedianMs: quickMedian, baselineMedianMs: baseline.baselineMedianMs, limitMs: limit, fullMs: full.ms }, backup: { ms: backup.ms, peakMiB: backup.peakMiB, fileMiB }, restore: { ms: restore.ms, peakMiB: restore.peakMiB, rows: restore.value.kind === 'restored' ? restore.value.summary.rows : null }, checks }, null, 1));
	process.exitCode = ok ? 0 : 1;
} finally {
	lc.shutdown();
	await cleanup(root);
}
