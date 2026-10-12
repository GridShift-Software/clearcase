import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { readHead, runGate, v5Current, v5Prerequisite } from '../../scripts/gate.mjs';

type Step = { name: string; cmd: string[]; browser?: boolean; needs?: () => string | null | Promise<string | null>; summary?: { dir: string; file: string; env?: string } };
const head = { sha: 'abc123def456', dirty: false };
let repo: string;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'gate-test-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

/** A stub exec: the step named in `failing` exits 1 after writing `noise` lines to its log; the rest pass. */
const stub = (failing: string | null, noise = 40, ran: string[][] = []) => (cmd: string[], logFile: string) => {
	ran.push(cmd);
	const failed = cmd.at(-1) === failing;
	writeFileSync(logFile, Array.from({ length: failed ? noise : 1 }, (_, i) => `${cmd.at(-1)} line ${i}`).join('\n'));
	return { status: failed ? 1 : 0 };
};
const steps: Step[] = [{ name: 'a', cmd: ['a'] }, { name: 'b', cmd: ['b'], browser: true }, { name: 'c', cmd: ['c'] }];
let t = 0;
const now = () => (t += 2000);

describe('runGate', () => {
	it('passes: one PASS line per step between the head line and GATE PASS', async () => {
		const r = await runGate(steps, { repo, env: {}, head, lock: null, run: stub(null), now });
		expect(r.pass).toBe(true);
		expect(r.lines).toEqual(['gate abc123def456 clean tree', 'PASS a 2s', 'PASS b 2s', 'PASS c 2s', 'GATE PASS abc123def456']);
	});

	it('stops at the first failure, skips the rest, and prints a bounded log tail', async () => {
		const ran: string[][] = [];
		const r = await runGate(steps, { repo, env: {}, head, lock: null, run: stub('b', 500, ran), now });
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

	it.each([
		['a spawn error', { status: null, error: new Error('spawn /x/lock ENOENT') }, 'gate: cannot run a: spawn /x/lock ENOENT'],
		['a signal', { status: null, signal: 'SIGTERM' }, 'gate: killed by SIGTERM'],
	])('fails %s and says why in the tail', async (_n, result, line) => {
		const r = await runGate(steps, { repo, env: {}, head, lock: null, run: () => result, now });
		expect(r.pass).toBe(false);
		expect(r.lines).toContain('FAIL a 2s');
		expect(r.lines).toContain(line);
		expect(r.lines.at(-1)).toBe('GATE FAIL a abc123def456');
	});

	it('fails a step that exits 75, the lock\'s own failure code', async () => {
		const r = await runGate(steps, { repo, env: {}, head, lock: null, run: () => ({ status: 75 }), now });
		expect(r.lines).toContain('FAIL a 2s');
		expect(r.lines.at(-1)).toBe('GATE FAIL a abc123def456');
	});

	it('marks a dirty tree on the first line', async () => {
		const r = await runGate(steps, { repo, env: {}, head: { ...head, dirty: true }, lock: null, run: stub(null), now });
		expect(r.lines[0]).toMatch(/DIRTY/);
	});

	it('wraps only browser steps in the lock command, and only when it is set', async () => {
		const withLock: string[][] = [];
		await runGate(steps, { repo, env: {}, head, lock: '/x/lock', run: stub(null, 0, withLock), now });
		expect(withLock).toEqual([['a'], ['/x/lock', 'b'], ['c']]);
		const without: string[][] = [];
		await runGate(steps, { repo, env: {}, head, lock: null, run: stub(null, 0, without), now });
		expect(without).toEqual([['a'], ['b'], ['c']]);
	});

	it('checks every prerequisite before the first step: a missing one fails its step and nothing runs', async () => {
		const ran: string[][] = [];
		const checks: string[] = [];
		const ok = () => { checks.push('ok'); return null; };
		const missing = async () => { checks.push('missing'); return 'stale prerequisite: x\nRefresh: y'; };
		const needy: Step[] = [{ name: 'a', cmd: ['a'], needs: ok }, steps[2], { name: 'p:q', cmd: ['p'], needs: missing }, { name: 'r', cmd: ['r'], needs: missing }];
		const r = await runGate(needy, { repo, env: {}, head, lock: null, run: stub(null, 0, ran), now });
		expect(ran).toEqual([]);
		expect(checks).toEqual(['ok', 'missing']);
		expect(r.failed).toBe('p:q');
		expect(r.lines).toEqual(['gate abc123def456 clean tree', 'FAIL p:q prerequisite (no step ran)', 'stale prerequisite: x', 'Refresh: y', `see ${join('.local', 'gate', 'p-q.log')}`, 'GATE FAIL p:q abc123def456']);
		expect(readFileSync(join(repo, '.local', 'gate', 'p-q.log'), 'utf8')).toBe('stale prerequisite: x\nRefresh: y\n');
	});
});

/** A real child process that writes `body` (a file's text) as its summary and exits 0; null writes nothing. The gate passes the folder in $PROBE_OUT. */
const probeWith = (body: string | null): Step => ({
	name: 'probe',
	cmd: [process.execPath, '-e', `const fs = require('node:fs'); const d = process.env.PROBE_OUT ?? ${JSON.stringify(join(repo, '.local', 'gate', 'probe-out'))}; fs.mkdirSync(d, { recursive: true }); if (${JSON.stringify(body)} !== null) fs.writeFileSync(d + '/summary.json', ${JSON.stringify(body)})`],
	summary: { dir: join('.local', 'gate', 'probe-out'), file: 'summary.json', env: 'PROBE_OUT' },
});
const probe = (doc: object | null) => probeWith(doc && JSON.stringify(doc));
const good = { ok: true, evidence: true, freshBuild: { head: `${head.sha}0000000000000000000000000000` } };
const gate = (s: Step) => runGate([s], { repo, env: {}, head, lock: null, now });

describe('evidence-qualified summaries', () => {
	it('fails a child that exits 0 and writes evidence: false', async () => {
		const r = await gate(probe({ ...good, evidence: false, evidenceNote: 'NOT release evidence: E2E_ONLY=x' }));
		expect(r.pass).toBe(false);
		expect(r.lines).toContain('FAIL probe 2s');
		expect(r.lines).toContain('probe: summary says evidence is not true: NOT release evidence: E2E_ONLY=x');
		expect(r.lines.at(-1)).toBe('GATE FAIL probe abc123def456');
	});

	it('fails a summary of another revision', async () => {
		const r = await gate(probe({ ...good, freshBuild: { head: 'f'.repeat(40) } }));
		expect(r.lines.at(-1)).toBe('GATE FAIL probe abc123def456');
		expect(r.lines.join('\n')).toMatch(/summary is for revision ffffffffffff, not HEAD abc123def456/);
	});

	it('fails when the child writes no summary, and a leftover one from an earlier run does not count', async () => {
		const dir = join(repo, '.local', 'gate', 'probe-out');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'summary.json'), JSON.stringify(good));
		const r = await gate(probe(null));
		expect(r.lines.at(-1)).toBe('GATE FAIL probe abc123def456');
		expect(r.lines.join('\n')).toMatch(/probe: no summary at .*summary\.json/);
	});

	it('fails a summary with ok: false or one that does not parse', async () => {
		expect((await gate(probe({ ...good, ok: false }))).pass).toBe(false);
		expect((await gate(probeWith('{'))).lines.join('\n')).toMatch(/probe: summary does not parse/);
	});

	it('passes a fresh evidence: true summary for HEAD', async () => {
		const r = await gate(probe(good));
		expect(r.pass).toBe(true);
		expect(r.lines.at(-1)).toBe('GATE PASS abc123def456');
	});
});

describe('reduced runs', () => {
	it.each(['E2E_ONLY', 'E2E_STOP_AFTER', 'E2E_LATENCY_SIZES_MIB', 'CLEARCASE_E2E_TMP', 'PARITY_MAX_COMBOS'])('refuses to start when %s is set, even empty', async (name) => {
		for (const value of ['1', '']) {
			const ran: string[][] = [];
			const r = await runGate(steps, { repo, env: { [name]: value }, head, lock: null, run: stub(null, 0, ran), now });
			expect(ran).toEqual([]);
			expect(r.pass).toBe(false);
			expect(r.lines.join('\n')).toContain(`${name} is set`);
			expect(r.lines.at(-1)).toBe('GATE FAIL env abc123def456');
		}
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

describe('v5Current', () => {
	const id = (c: string) => `sha256:${c.repeat(64)}`;
	const fx = (viewContent: boolean) => {
		const accepted = { resultsVersion: id('a'), diagnosticsSha256: id('d') };
		return { cfg: { mainHtml: { path: '/v5.html' } }, caseFolder: '/case', caseId: 'c', acceptedBase: accepted, accepted: viewContent ? { ...accepted, resultsVersion: id('b') } : accepted };
	};
	/** A converter stub that writes a manifest with `resultsVersion`, or fails. */
	const converter = (resultsVersion: string | null, seen: string[] = []) => ({ out }: { out: string }) => {
		seen.push(out);
		if (resultsVersion === null) return { exit: 1, stderr: 'boom\n' };
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, 'manifest.json'), JSON.stringify({ resultsVersion }));
		return { exit: 0, stderr: '' };
	};

	it('passes when the conversion carries the accepted resultsVersion, and removes it', async () => {
		const seen: string[] = [];
		expect(await v5Current(repo, { load: async () => fx(true), convert: converter(id('b'), seen) })).toBeNull();
		expect(seen).toEqual([join(repo, '.local', 'gate', 'v5-preflight', 'pkg')]);
		expect(existsSync(join(repo, '.local', 'gate', 'v5-preflight'))).toBe(false);
	});

	it('names the accepted and the expected resultsVersion, the field to change and how to refresh', async () => {
		const problem = await v5Current(repo, { load: async () => fx(true), convert: converter(id('c')) });
		expect(problem).toMatch(new RegExp(`^stale prerequisite: .*v5-verification\\.json accepts resultsVersion ${id('b')}\n`));
		expect(problem).toContain(`converts the v5 sample to ${id('c')}`);
		expect(problem).toContain(`set acceptedViewContent.resultsVersion to ${id('c')}`);
		expect(problem).toMatch(/Refresh: copy the coordinator's current locator/);
		expect(problem!.split('\n').every((l: string) => l.length <= 160)).toBe(true);
		expect(await v5Current(repo, { load: async () => fx(false), convert: converter(id('c')) })).toContain(`set accepted.resultsVersion to ${id('c')}`);
	});

	it('reports a locator loadConfig refuses, and a failed conversion', async () => {
		const refuse = async () => { throw new Error('/x/v5-verification.json: caseId is required'); };
		expect(await v5Current(repo, { load: refuse, convert: converter(id('b')) })).toBe('invalid prerequisite: /x/v5-verification.json: caseId is required');
		expect(await v5Current(repo, { load: async () => fx(true), convert: converter(null) })).toBe('v5 conversion failed (exit 1): boom');
	});
});

describe('readHead', () => {
	const ok = (out: string) => ({ status: 0, stdout: `${out}\n` });
	it('reads the sha and the dirty flag', () => {
		expect(readHead((_c: string, a: string[]) => (a[0] === 'rev-parse' ? ok('abc') : ok(' M x')))).toEqual({ head: { sha: 'abc', dirty: true } });
		expect(readHead((_c: string, a: string[]) => (a[0] === 'rev-parse' ? ok('abc') : ok('')))).toEqual({ head: { sha: 'abc', dirty: false } });
	});
	it('reports a git that exits non-zero or cannot spawn, instead of a clean tree', () => {
		expect(readHead(() => ({ status: 128, stdout: '', stderr: 'fatal: detected dubious ownership\n' }))).toEqual({ error: 'rev-parse exited 128: fatal: detected dubious ownership' });
		expect(readHead(() => ({ error: new Error('spawn git ENOENT'), stdout: null }))).toEqual({ error: 'spawn git ENOENT' });
		expect(readHead((_c: string, a: string[]) => (a[0] === 'rev-parse' ? ok('abc') : { status: 1, stdout: '', stderr: '' }))).toEqual({ error: 'status exited 1: ' });
	});
});
