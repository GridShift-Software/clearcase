// Fail fast when the browser dies (lib/cdp.mjs, lib/lifecycle.mjs): a browser killed in the middle of a step, a
// crashed page and a step past its deadline each end the step at once, naming it and the cause; a crash at launch is
// retried once and recorded, a second one fails the launch. Then the real e2e suite runner (suite.mjs, offline in its
// own namespace) with a Chromium that is killed in the middle of a scenario, or that dies at every launch: it exits 1
// within seconds, and suite.json names the step and the cause and says `evidence: false`. Real headless Chromium; the
// stand-in (lib/crashing-chromium.mjs) runs it and kills it on cue. Synthetic pages only.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const HERE = import.meta.dirname;
const { BrowserDied, browserDeath, CHROME, LaunchFailed, launch, newPage } = await import(join(HERE, 'cdp.mjs'));
const { abortOf, guard, StepAborted } = await import(join(HERE, 'lifecycle.mjs'));
const { offlineStep } = await import(join(HERE, '..', 'run.mjs'));
const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'cc-lifecycle-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** CLEARCASE_CHROMIUM for the stand-in: a shell script that runs lib/crashing-chromium.mjs with Bun. */
const shim = join(root, 'chromium');
writeFileSync(shim, `#!/bin/sh\nexec '${BUN}' '${join(HERE, 'crashing-chromium.mjs')}' "$@"\n`);
chmodSync(shim, 0o755);
/** Run fn with these environment variables set (the stand-in reads them when it is launched). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	Object.assign(process.env, vars);
	try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
/** The rejection of p and how long it took. */
async function rejection(p: Promise<unknown>, t0 = Date.now()) {
	try { await p; } catch (e) { return { e: e as Error & { step?: string; why?: string; kind?: string }, ms: Date.now() - t0 }; }
	throw new Error('expected a rejection');
}

describe('a browser step fails fast', () => {
	test('a browser killed in the middle of a step ends it at once; pending, later and waiting commands reject too', async () => {
		expect(existsSync(CHROME), `Chromium not found at ${CHROME}; set CLEARCASE_CHROMIUM`).toBe(true);
		const b = await launch({ profileRoot: join(root, 'kill') });
		try {
			expect(b.launch).toEqual({ attempts: 1 });
			const p = await newPage(b);
			const pending = rejection(p.evaluate('new Promise(() => {})'));
			const event = rejection(b.once(() => false, 600_000));
			setTimeout(() => b.proc.kill('SIGKILL'), 300);
			const { e, ms } = await rejection(guard('scenario KILLED', 60_000, () => p.waitFor('false', 600_000)));
			expect(e).toBeInstanceOf(StepAborted);
			expect(e.message).toBe('scenario KILLED: Chromium exited (signal SIGKILL)');
			expect(e.kind).toBe('browser');
			expect(ms).toBeLessThan(5000);
			const pe = await pending, ev = await event;
			expect(pe.e).toBeInstanceOf(BrowserDied);
			expect(pe.ms).toBeLessThan(5000);
			expect(ev.e).toBeInstanceOf(BrowserDied);
			const later = await rejection(b.send('Runtime.evaluate', { expression: '1' }));
			expect(later.ms).toBeLessThan(50);
			// a step that starts after the death fails before it runs
			let ran = false;
			const next = await rejection(guard('scenario NEXT', 60_000, async () => { ran = true; }));
			expect([next.e.message, ran]).toEqual(['scenario NEXT: Chromium exited (signal SIGKILL)', false]);
		} finally { await b.close(); }
		expect(browserDeath()).toBeNull(); // a closed browser is no longer the run's
	});

	test('a crashed page (its renderer killed) ends the step at once', async () => {
		const b = await launch({ profileRoot: join(root, 'crash') });
		try {
			const p = await newPage(b);
			await p.navigate('data:text/html,<p>synthetic</p>');
			const { processInfo } = await b.send('SystemInfo.getProcessInfo');
			setTimeout(() => { for (const x of processInfo) if (x.type === 'renderer') process.kill(x.id, 'SIGKILL'); }, 300);
			const { e, ms } = await rejection(guard('view synthetic', 60_000, () => p.waitFor('false', 600_000)));
			expect(e.message).toBe('view synthetic: a page crashed');
			expect(e.kind).toBe('browser');
			expect(ms).toBeLessThan(5000);
		} finally { await b.close(); }
	});

	test('a step past its deadline ends with a timeout naming it; closing a browser is not a death', async () => {
		const { e, ms } = await rejection(guard('lane-04', 300, () => new Promise(() => {})));
		expect([e.message, e.kind]).toEqual(['lane-04: no result within 0.3 s (timeout)', 'timeout']);
		expect(ms).toBeLessThan(2000);
		const b = await launch({ profileRoot: join(root, 'close') });
		const p = await newPage(b);
		const step = rejection(guard('scenario CLOSING', 3000, () => p.waitFor('false', 600_000)));
		await b.close();
		expect((await step).e.message).toBe('the browser was closed');
	});

	test('a crash at launch is retried once with a fresh browser, and the retry is recorded', async () => {
		const b = await withEnv<{ launch: unknown; close: () => Promise<void> }>({ CRASH_AT: 'launch', CRASH_ONCE: join(root, 'crashed-once'), REAL_CHROMIUM: CHROME }, () => launch({ profileRoot: join(root, 'retry'), chrome: shim }));
		try {
			expect(b.launch).toEqual({ attempts: 2, retried: 'Chromium exited (signal SIGKILL) before its DevTools endpoint' });
			const p = await newPage(b);
			expect(await p.evaluate('1 + 1')).toBe(2);
		} finally { await b.close(); }
	});

	test('a crash at every launch fails the launch after one retry, within seconds', async () => {
		const { e, ms } = await rejection(withEnv({ CRASH_AT: 'launch', REAL_CHROMIUM: CHROME }, () => launch({ profileRoot: join(root, 'twice'), chrome: shim })));
		expect(e).toBeInstanceOf(LaunchFailed);
		expect(e.message).toBe('Chromium failed to launch twice: Chromium exited (signal SIGKILL) before its DevTools endpoint; then Chromium exited (signal SIGKILL) before its DevTools endpoint');
		expect(ms).toBeLessThan(10_000);
		expect(abortOf(e, 'browser launch')?.record).toEqual({ step: 'browser launch', cause: e.message, kind: 'launch' });
	});
});

describe('the e2e suite runner exits non-zero within seconds when the browser dies', () => {
	/** suite.mjs offline in its own namespace with the stand-in Chromium; its exit, output, time and suite.json. */
	function suite(name: string, vars: Record<string, string>) {
		const out = join(root, name);
		const [cmd, args] = offlineStep(join(HERE, '..', 'suite.mjs'));
		// a fresh namespace of its own, also when this suite already runs in one (offline.sh then sets CLEARCASE_OFFLINE*)
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLEARCASE_OFFLINE')));
		const t0 = Date.now();
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, env: { ...env, CLEARCASE_CHROMIUM: shim, REAL_CHROMIUM: CHROME, CLEARCASE_E2E_OUT: out, ...vars } });
		return { status: r.status, output: r.stdout + r.stderr, ms: Date.now() - t0, record: JSON.parse(readFileSync(join(out, 'suite.json'), 'utf8')) };
	}

	test('Chromium killed in the middle of a scenario: the scenario fails, the run stops, evidence: false', () => {
		const r = suite('mid-run', { CRASH_ON_PAGE: '2' }); // the page NET-CANARY opens
		expect(r.status, r.output).toBe(1);
		expect(r.ms).toBeLessThan(60_000); // the whole suite takes about a minute when nothing dies
		expect(r.record.aborted).toEqual({ step: 'scenario NET-CANARY', cause: 'Chromium exited (signal SIGKILL)', kind: 'browser' });
		expect([r.record.evidence, r.record.evidenceNote]).toEqual([false, 'NOT release evidence: run aborted in scenario NET-CANARY: Chromium exited (signal SIGKILL)']);
		expect(r.record.browser).toEqual({ attempts: 1 });
		expect(r.record.results.map((x: { id: string; status: string }) => `${x.id} ${x.status}`)).toEqual(['NET-OFFLINE PASS', 'NET-CANARY FAIL', 'ABORTED FAIL']);
		expect(r.output).toMatch(/^FAIL {4}ABORTED run aborted in scenario NET-CANARY: Chromium exited \(signal SIGKILL\)$/m);
	});

	test('Chromium dies at every launch: one retry, then the run stops, evidence: false', () => {
		const r = suite('at-launch', { CRASH_AT: 'launch' });
		expect(r.status, r.output).toBe(1);
		expect(r.ms).toBeLessThan(30_000);
		expect(r.output).toMatch(/chromium: launch failed \(Chromium exited \(signal SIGKILL\) before its DevTools endpoint\); retrying once with a fresh browser and profile/);
		expect(r.record.aborted).toMatchObject({ step: 'browser launch', kind: 'launch', cause: expect.stringMatching(/^Chromium failed to launch twice: /) });
		expect(r.record.evidence).toBe(false);
		expect(r.record.results.map((x: { id: string; status: string }) => `${x.id} ${x.status}`)).toEqual(['NET-OFFLINE PASS', 'ABORTED FAIL']);
	});
});
