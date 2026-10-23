import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanArtifacts } from './artifacts.mjs';
import { git, problems } from './check.mjs';

// Every completed attempt, including failure/interruption, scans before it can release the signal hook.
export function finishRun({ summary, metadata = () => ({}), dir, buildDir, canaries, failure }) {
	summary.evidence = false;
	let reportingOkay = true;
	try { Object.assign(summary, metadata()); } catch { reportingOkay = false; }
	try { writeFileSync(path.join(dir, 'summary-scan.json'), JSON.stringify(summary, null, 2)); } catch { reportingOkay = false; }
	// Neither Git metadata nor report I/O is a prerequisite for examining existing artifacts.
	let scanOkay = false;
	try { summary.scan = scanArtifacts(dir, buildDir, canaries); scanOkay = summary.scan.hits === 0; }
	catch { summary.scan = { files: 0, hits: 1, manifest: [] }; }
	try {
		summary.treeClean = summary.treeClean && git(['rev-parse', 'HEAD']) === summary.sourceSha && !git(['status', '--porcelain']);
		summary.evidence = reportingOkay && !failure.failed && !failure.interrupted && failure.cleanupOkay && scanOkay && problems({ ...summary, evidence: true }, { head: summary.sourceSha }).length === 0;
	} catch { reportingOkay = false; summary.evidence = false; }
	try { writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); }
	catch { reportingOkay = false; summary.evidence = false; }
	if (!summary.evidence) {
		try { writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ sourceSha: summary.sourceSha, ...failure, cleanup: summary.cleanup, reportingOkay, scanOkay, scan: summary.scan, evidence: false })); }
		catch { /* The caller still returns failure when the filesystem cannot record it. */ }
	}
	return summary;
}
