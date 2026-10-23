import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanArtifacts } from './artifacts.mjs';
import { git, problems } from './check.mjs';

// Every completed attempt, including failure/interruption, scans before it can release the signal hook.
export function finishRun({ summary, dir, buildDir, canaries, failure }) {
	summary.evidence = false;
	writeFileSync(path.join(dir, 'summary-scan.json'), JSON.stringify(summary, null, 2));
	let scanOkay = false;
	try { summary.scan = scanArtifacts(dir, buildDir, canaries); scanOkay = summary.scan.hits === 0; }
	catch { summary.scan = { files: 0, hits: 1, manifest: [] }; }
	summary.treeClean = summary.treeClean && git(['rev-parse', 'HEAD']) === summary.sourceSha && !git(['status', '--porcelain']);
	summary.evidence = !failure.failed && !failure.interrupted && failure.cleanupOkay && scanOkay && problems({ ...summary, evidence: true }, { head: summary.sourceSha }).length === 0;
	writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
	if (!summary.evidence) writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ sourceSha: summary.sourceSha, ...failure, cleanup: summary.cleanup, scanOkay, scan: summary.scan, evidence: false }));
	return summary;
}
