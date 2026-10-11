import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { runGate, v5Prerequisite } from '../../scripts/gate.mjs';

type Step = { name: string; cmd: string[]; browser?: boolean; needs?: () => string | null };
const head = { sha: 'abc123def456', dirty: false };
let repo: string;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'gate-test-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

/** A stub exec: the step named in `failing` exits 1 after writing `noise` lines to its log; the rest pass. */
const stub = (failing: string | null, noise = 40, ran: string[][] = []) => (cmd: string[], logFile: string) => {
	ran.push(cmd);
	const failed = cmd.at(-1) === failing;
	writeFileSync(logFile, Array.from({ length: failed ? noise : 1 }, (_, i) => `${cmd.at(-1)} line ${i}`).join('\n'));
	return failed ? 1 : 0;
};
const steps: Step[] = [{ name: 'a', cmd: ['a'] }, { name: 'b', cmd: ['b'], browser: true }, { name: 'c', cmd: ['c'] }];
let t = 0;
const now = () => (t += 2000);

describe('runGate', () => {
	it('passes: one PASS line per step between the head line and GATE PASS', () => {
		const r = runGate(steps, { repo, head, lock: null, run: stub(null), now });
		expect(r.pass).toBe(true);
		expect(r.lines).toEqual(['gate abc123def456 clean tree', 'PASS a 2s', 'PASS b 2s', 'PASS c 2s', 'GATE PASS abc123def456']);
	});

	it('stops at the first failure, skips the rest, and prints a bounded log tail', () => {
		const ran: string[][] = [];
		const r = runGate(steps, { repo, head, lock: null, run: stub('b', 500, ran), now });
		expect(r.pass).toBe(false);
		expect(r.failed).toBe('b');
		expect(ran).toEqual([['a'], ['b']]);
		expect(r.lines.slice(1, 4)).toEqual(['PASS a 2s', 'FAIL b 2s', 'SKIP c']);
		expect(r.lines.at(-1)).toBe('GATE FAIL b abc123def456');
		expect(r.lines.length).toBeLessThanOrEqual(30);
		expect(r.lines).toContain('b line 499');
		expect(r.lines).not.toContain('b line 0');
		expect(readFileSync(join(repo, '.local', 'gate', 'b.log'), 'utf8').split('\n')).toHaveLength(500);
	});

	it('marks a dirty tree on the first line', () => {
		const r = runGate(steps, { repo, head: { ...head, dirty: true }, lock: null, run: stub(null), now });
		expect(r.lines[0]).toMatch(/DIRTY/);
	});

	it('wraps only browser steps in the lock command, and only when it is set', () => {
		const withLock: string[][] = [];
		runGate(steps, { repo, head, lock: '/x/lock', run: stub(null, 0, withLock), now });
		expect(withLock).toEqual([['a'], ['/x/lock', 'b'], ['c']]);
		const without: string[][] = [];
		runGate(steps, { repo, head, lock: null, run: stub(null, 0, without), now });
		expect(without).toEqual([['a'], ['b'], ['c']]);
	});

	it('fails, never skips, a step whose prerequisite is missing, without running it', () => {
		const ran: string[][] = [];
		const needy: Step[] = [{ name: 'a', cmd: ['a'], needs: () => 'missing prerequisite: x' }, steps[2]];
		const r = runGate(needy, { repo, head, lock: null, run: stub(null, 0, ran), now });
		expect(ran).toEqual([]);
		expect(r.lines).toContain('FAIL a 2s');
		expect(r.lines).toContain('missing prerequisite: x');
		expect(r.lines.at(-1)).toBe('GATE FAIL a abc123def456');
	});
});

describe('v5Prerequisite', () => {
	it('names a missing locator, then a missing case folder, then passes', () => {
		expect(v5Prerequisite(repo)).toMatch(/missing prerequisite: .*v5-verification\.json/);
		mkdirSync(join(repo, '.local'));
		writeFileSync(join(repo, '.local', 'v5-verification.json'), JSON.stringify({ caseFolder: join(repo, 'tree') }));
		expect(v5Prerequisite(repo)).toMatch(/case folder/);
		mkdirSync(join(repo, 'tree'));
		expect(v5Prerequisite(repo)).toBeNull();
	});
});
