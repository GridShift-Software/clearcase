// Proves that `bun run --bun test` (cases.ts) refuses stale or inconsistent committed evidence (GRS-111). From this directory:
//
//   bun run --bun tamper
//
// Copies the committed summary, changes one binding field of the copy, and runs cases.ts on it through
// NOTIFICATIONS_EVIDENCE. The untouched copy must pass the evidence section (its EVIDENCE PASS line) and every changed
// copy must fail it (EVIDENCE FAIL). Exit 1 on any that goes the wrong way. The changed copies keep their shape (the
// SHAs agree with each other), so only a check of the evidence's binding to this branch can refuse them.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const committed = JSON.parse(readFileSync(path.join(HERE, '../../../docs/acceptance/hosting/evidence/notifications-summary.json'), 'utf8')) as Record<string, any>;
const sha = (rev: string) => spawnSync('git', ['rev-parse', rev], { cwd: HERE, encoding: 'utf8' }).stdout.trim();

// 67ffc21c is the branch base, where the probe did not exist; 238199f5 is an ancestor from before the probe last changed.
const named = (rev: string) => (s: Record<string, any>) => ((s.sourceSha = sha(rev)), (s.servedRevision = sha(rev)));
const variants: [string, ((s: Record<string, any>) => void) | null][] = [
	['the committed file, untouched', null],
	['sourceSha is the branch base, where the probe did not exist', named('67ffc21c')],
	['sourceSha is an ancestor from before the probe last changed', named('238199f5')],
	['sourceSha is not an ancestor of HEAD', named('0'.repeat(40))],
	['artifact is zeroed', (s) => (s.artifact = `sha256:${'0'.repeat(64)}`)],
	['mutationsRefused is 1', (s) => (s.checker.mutationsRefused = 1)],
	['finishedAt is before startedAt', (s) => (s.finishedAt = new Date(Date.parse(s.startedAt) - 1000).toISOString())],
	["runDir is another run's", (s) => (s.runDir = '.local/hosting-probe/notifications/2026-01-01T00-00-00-000Z')],
];

const dir = mkdtempSync(path.join(tmpdir(), 'notifications-tamper-'));
const wrong: string[] = [];
try {
	for (const [i, [label, change]] of variants.entries()) {
		const copy = structuredClone(committed);
		change?.(copy);
		const file = path.join(dir, `${i}.json`);
		writeFileSync(file, JSON.stringify(copy, null, 2));
		const r = spawnSync(process.execPath, ['cases.ts'], { cwd: HERE, env: { ...process.env, NOTIFICATIONS_EVIDENCE: file }, encoding: 'utf8' });
		const refused = r.stdout.includes('EVIDENCE FAIL');
		const passed = r.stdout.includes('EVIDENCE PASS');
		if (change === null ? !passed : !refused) wrong.push(`${label}: ${change === null ? 'refused' : 'accepted'}`);
		else console.log(`ok      ${label}: ${change === null ? 'passes' : `refused (${r.stdout.split('\n').find((l) => l.startsWith('the committed evidence is'))?.split('recomputed (')[1]?.slice(0, 120) ?? '?'})`}`);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log(wrong.join('\n'));
console.log(wrong.length ? `TAMPER FAIL: ${wrong.length} went the wrong way` : 'TAMPER PASS');
process.exit(wrong.length ? 1 : 0);
