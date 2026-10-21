// The evidence check (check.ts): its exact shape, its recomputed route table and counts, and its binding to an ancestor
// sourceSha and the probe's own inputs, in a scratch Git repository.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { checkSummary, countsOf, HOLD, inputsDigest, INPUT_PATHS, LEGS, SCHEMA } from './check.ts';
import { classesOf, expectFor, label, rows } from './matrix.ts';
import pkg from './package.json' with { type: 'json' };

const SOURCE = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ctx = { head: SOURCE, digestAt: () => DIGEST, isAncestor: () => true };

/** A summary the runner would write for a run where everything passed. */
function passing(): Record<string, unknown> {
	const routes = rows().map((r) => ({ app: r.app, method: r.method, route: r.route, gate: r.gate, checks: classesOf(r).map((cls) => ({ class: cls, expect: label(expectFor(r, cls)), got: label(expectFor(r, cls)), leak: [] as string[], missing: false })) }));
	const bun = pkg.packageManager.replace(/^bun@/, '');
	const instance = (name: string) => ({ name, environment: 'development', signUpMode: 'restricted', mfaRequired: false, secondFactors: 0, captcha: false, tokenSeconds: 60 });
	return {
		schema: SCHEMA,
		sourceSha: SOURCE,
		inputs: { paths: [...INPUT_PATHS], digest: DIGEST },
		treeClean: true,
		servedStamp: SOURCE,
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:05:00.000Z',
		runDir: '.local/hosting-probe/identity/run-1',
		hosts: { bun, node: '24.0.0', build: `Bun ${bun}`, runner: 'Node 24.0.0', wrangler: 'Node 24.0.0', app: `workerd ${pkg.devDependencies.workerd} (native)` },
		pins: { ...pkg.devDependencies },
		artifact: `sha256:${'c'.repeat(64)}`,
		instances: { client: instance('Clear-Case-Dev-A'), staff: instance('Clear-Case-Dev-B') },
		legs: Object.fromEntries(LEGS.map((n) => [n, { status: 'PASS', asserted: ['a synthetic assertion'] }])),
		routes,
		counts: countsOf(routes),
		clerk: { users: { created: 9, deleted: 9 }, invitations: { created: 12, deleted: 12 }, sessions: { created: 20, ended: 20, pending: 0 }, testingTokens: { created: 20 }, devBrowsers: { created: 20 }, apiCalls: { backend: 100 } },
		hold: [...HOLD],
		failure: null,
		evidence: true,
	};
}

describe('shape, table and counts', () => {
	test('a passing summary passes (the control)', () => {
		expect(checkSummary(passing(), ctx)).toEqual([]);
	});

	test('every field deleted, nulled, retyped, emptied, flipped or zeroed, and an unknown key in each object, is refused', () => {
		const base = passing();
		let refused = 0;
		const accepted: string[] = [];
		const attempt = (labelText: string, edit: (copy: any) => void) => {
			const copy = structuredClone(base);
			edit(copy);
			if (JSON.stringify(copy) === JSON.stringify(base)) return;
			if (checkSummary(copy, ctx).length) refused++;
			else accepted.push(labelText);
		};
		const walk = (value: unknown, p: (string | number)[]) => {
			const holder = (c: any) => p.slice(0, -1).reduce((o, k) => o[k], c);
			if (p.length) {
				const key = p.at(-1)!;
				attempt(`${p.join('.')} deleted`, (c) => (Array.isArray(holder(c)) ? holder(c).splice(key as number, 1) : delete holder(c)[key]));
				attempt(`${p.join('.')} null`, (c) => (holder(c)[key] = null));
				attempt(`${p.join('.')} retyped`, (c) => (holder(c)[key] = typeof value === 'string' ? 1 : typeof value === 'object' && value !== null ? 'x' : String(value)));
				if (typeof value === 'string') attempt(`${p.join('.')} emptied`, (c) => (holder(c)[key] = ''));
				if (typeof value === 'boolean') attempt(`${p.join('.')} flipped`, (c) => (holder(c)[key] = !value));
				if (typeof value === 'number') attempt(`${p.join('.')} zeroed`, (c) => (holder(c)[key] = 0));
			}
			if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...p, i]));
			else if (value && typeof value === 'object') {
				attempt(`${p.join('.') || '<root>'} + unknown key`, (c) => (p.reduce((o: any, k) => o[k], c).__unknown = 1));
				for (const [k, v] of Object.entries(value)) walk(v, [...p, k]);
			}
		};
		walk(base, []);
		expect(accepted).toEqual([]);
		expect(refused).toBeGreaterThan(5000);
	});

	test('a session still pending, one not ended, or one still active in Clerk is refused: sessions.ended is counted from Clerk, not assumed', () => {
		for (const [what, edit] of [
			['one pending', (c: any) => (c.clerk.sessions.pending = 1)],
			['one pending and so one fewer ended', (c: any) => ((c.clerk.sessions.pending = 1), (c.clerk.sessions.ended -= 1))],
			['one not ended', (c: any) => (c.clerk.sessions.ended -= 1)],
		] as const) {
			const copy = structuredClone(passing());
			edit(copy);
			expect([what, checkSummary(copy, ctx).length > 0]).toEqual([what, true]);
		}
	});

	test('a check whose response differs from its expectation, a leak, a missing marker or a dropped route is refused', () => {
		const edits: [string, (s: any) => void][] = [
			['got differs', (s) => (s.routes[8].checks[0].got = '200')],
			['expectation rewritten to match a wrong response', (s) => ((s.routes[8].checks[0].expect = '200'), (s.routes[8].checks[0].got = '200'))],
			['a leaked marker', (s) => s.routes[8].checks[0].leak.push('CC108-CASE2-META')],
			['a missing marker', (s) => (s.routes[8].checks.at(-1).missing = true)],
			['a route dropped, counts recomputed', (s) => (s.routes.pop(), (s.counts = countsOf(s.routes)))],
			['a class dropped, counts recomputed', (s) => (s.routes[8].checks.pop(), (s.counts = countsOf(s.routes)))],
			['a route the app does not serve', (s) => s.routes.push({ ...s.routes[0], route: '/debug' })],
			['counts not recomputed', (s) => (s.counts.checks += 1)],
			['a Clerk user left behind', (s) => (s.clerk.users.deleted -= 1)],
			['an invitation left behind', (s) => (s.clerk.invitations.deleted -= 1)],
			['a session not ended', (s) => (s.clerk.sessions.ended -= 1)],
			['a leg not PASS', (s) => (s.legs.cleanup.status = 'FAIL')],
			['a HOLD dropped', (s) => s.hold.pop()],
		];
		for (const [what, edit] of edits) {
			const s = passing();
			edit(s);
			expect(checkSummary(s, ctx), what).not.toEqual([]);
		}
	});
});

describe('binding to an ancestor sourceSha and the inputs only', () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'cc108-bind-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args: string[]) => {
		const r = spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir } });
		if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
		return r.stdout.trim();
	};
	const write = (file: string, text: string) => (mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }), writeFileSync(path.join(dir, file), text));
	const commit = (file: string, text: string) => (write(file, text), git('add', '-A'), git('commit', '-q', '-m', file), git('rev-parse', 'HEAD'));
	const at = (summarySha: string, digestSha = summarySha) => {
		const s = passing();
		s.sourceSha = summarySha;
		s.servedStamp = summarySha;
		(s.inputs as { digest: string }).digest = inputsDigest(digestSha, dir);
		const head = git('rev-parse', 'HEAD');
		return checkSummary(s, { head, digestAt: (rev) => inputsDigest(rev, dir), isAncestor: (rev) => spawnSync('git', ['merge-base', '--is-ancestor', rev, head], { cwd: dir }).status === 0 });
	};

	git('init', '-q', '-b', 'main');
	for (const p of INPUT_PATHS) write(p.endsWith('identity') ? `${p}/probe.ts` : p, `synthetic ${p}\n`);
	write('deploy/probes/scan.ts', 'synthetic scan\n');
	const source = commit('README.md', 'synthetic\n');

	test('at its own revision the summary passes', () => {
		expect(at(source)).toEqual([]);
	});

	test('a later commit outside the inputs (another probe, deploy/probes/scan.ts, the app) keeps it valid', () => {
		commit('src/app.ts', 'synthetic app change\n');
		commit('deploy/probes/scan.ts', 'synthetic scan change\n');
		expect(at(source)).toEqual([]);
	});

	test('a merge that brings changes outside the inputs keeps it valid', () => {
		git('checkout', '-q', '-b', 'wave');
		commit('docs/other.md', 'synthetic wave doc\n');
		git('checkout', '-q', 'main');
		commit('tests/other-probe/x.ts', 'synthetic other probe\n');
		git('merge', '-q', '--no-edit', 'wave');
		expect(at(source)).toEqual([]);
	});

	test("a change to the probe's directory makes it stale", () => {
		git('checkout', '-q', '-b', 'probe-change');
		commit('tests/hosting-probe/identity/probe.ts', 'synthetic changed probe\n');
		expect(at(source).join('\n')).toMatch(/inputs\.digest/);
		git('checkout', '-q', 'main');
	});

	test("a change to GRS-107's secrets reader makes it stale", () => {
		git('checkout', '-q', '-b', 'reader-change');
		commit('deploy/probes/secrets-child.mjs', 'synthetic changed reader\n');
		expect(at(source).join('\n')).toMatch(/inputs\.digest/);
		git('checkout', '-q', 'main');
	});

	test('a summary that names HEAD as its sourceSha, with the digest of an older run, is refused', () => {
		git('checkout', '-q', 'probe-change');
		expect(at(git('rev-parse', 'HEAD'), source).join('\n')).toMatch(/inputs\.digest/);
		git('checkout', '-q', 'main');
	});

	test('a sourceSha that is not an ancestor of HEAD is refused, even with equal inputs', () => {
		git('checkout', '-q', '-b', 'sibling', source);
		const sibling = commit('docs/sibling.md', 'synthetic sibling\n');
		git('checkout', '-q', 'main');
		expect(at(sibling).join('\n')).toMatch(/not HEAD or an ancestor/);
	});
});
