// The local and Clerk-development legs of the identity proof (GRS-108). From this directory:
//
//   bun install --frozen-lockfile   # once, online: this workspace's own pins, apart from the root lockfile
//   bun run --bun probe [--out FILE]
//
// `probe` (live.ts, on Bun) runs this file on a real Node under GRS-107's reader (bun ../../../deploy/probes/secrets.ts
// run clerk-dev --keys ... -- <node> probe.ts), which hands the four Clerk development keys to a Node child only, over fd
// 3 and its preload; nothing else reads the secrets file. The runner builds the probe app with Bun (PROBE_BUN), serves the client instance (client A) and the staff app on native workerd through serve.mjs (Node hosts
// Wrangler only) with local D1 and R2, and drives both against the real development instances Clear-Case-Dev-A
// (client) and Clear-Case-Dev-B (staff). There is no Cloudflare account, login or deploy. Identities are synthetic
// (+clerk_test addresses on example.com: Clerk sends nothing and takes the fixed test code). Every user, invitation and
// session it creates is deleted in a finally step, failure or not, and counted.
//
// It refuses (exit 2) a dirty tree, a runner that is not a real Node, a build Bun other than packageManager's, an
// installed package that is not its pin, keys not handed over by the reader, or a missing key. Otherwise it writes the summary (default .local/hosting-probe/identity/summary.json)
// and exits 0 only when `evidence` is true. check.ts judges a committed summary; see its header for the binding rule.
import { type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scanPaths } from '../../../deploy/probes/scan.ts';
import { checkSummary, countsOf, HOLD, inputsDigest, INPUT_PATHS, LEGS, SCHEMA, type LegName } from './check.ts';
import { Backend, Browser, ClerkError, claimsOf, frontendApi, Pace, ticketOf } from './clerk.ts';
import { appEnv, BUN, build, checkInstalled, fetchApp, freePorts, HERE, onInterrupt, realNode, Refusal, run, seed, startServe, stopServe, type Reply, type ServeConfig } from './harness.ts';
import { CLASS_ORDER, classesOf, expectFor, label, MARKERS, mayShow, ownInstance, pathOf, rows, type Class, type Row } from './matrix.ts';

const KEYS = ['CLIENT_A_PK', 'CLIENT_A_SK', 'STAFF_PK', 'STAFF_SK'] as const;
type AppName = 'client' | 'staff';
/** The claims Clerk's v2 session token carries; a key outside this set would be data the probe did not expect in Clerk. */
const CLAIMS = ['azp', 'exp', 'fva', 'iat', 'iss', 'nbf', 'sid', 'sts', 'sub', 'v'];

type Leg = { status: 'PASS' | 'FAIL' | 'NOT RUN'; asserted: string[]; failure?: string };

function git(...args: string[]): string {
	const r = run('git', args, { env: { PATH: '/usr/bin:/bin' } });
	if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${r.out.trim()}`);
	return r.out.trim();
}
const head = () => git('rev-parse', 'HEAD');
const dirty = () => git('status', '--porcelain', '--untracked-files=all');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The executable names of `root`'s descendant processes, from /proc. */
function descendants(root: number): string[] {
	const all = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).flatMap((n) => {
		try {
			const stat = readFileSync(`/proc/${n}/stat`, 'utf8');
			return [{ pid: Number(n), ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), exe: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) }];
		} catch {
			return [];
		}
	});
	const ids = new Set([root]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const p of all) if (!ids.has(p.pid) && ids.has(p.ppid)) (ids.add(p.pid), (grew = true));
	}
	return all.filter((p) => ids.has(p.pid) && p.pid !== root).map((p) => p.exe);
}

async function main(out: string): Promise<number> {
	const root = git('rev-parse', '--show-toplevel');
	const sha = head();
	if (process.versions.bun !== undefined) throw new Refusal("the runner is a real Node, the only child GRS-107's reader hands keys to: run `bun run --bun probe`");
	const bun = process.env.PROBE_BUN ?? '';
	const bunVersion = bun ? run(bun, ['--version']).out.trim() : '';
	if (bunVersion !== BUN) throw new Refusal(`builds with Bun ${BUN} only (packageManager); PROBE_BUN names ${bunVersion || 'no Bun'}`);
	if (dirty()) throw new Refusal('the tree is dirty: commit or stash first, so the summary describes HEAD');
	const node = realNode();
	// free ports, so two worktrees' runs (or a run and the root test) never share the two Workers' ports
	const [clientPort, staffPort] = await freePorts(2);
	const ORIGIN = { client: `http://127.0.0.1:${clientPort}`, staff: `http://127.0.0.1:${staffPort}` } as const;
	const pins = checkInstalled();
	// GRS-107's child half of the reader, untyped .mjs: a computed specifier keeps tsc from asking for its declarations
	const child = '../../../deploy/probes/secrets-child.mjs';
	const { takeSecrets } = (await import(child)) as { takeSecrets: () => Map<string, string> };
	let keys: Map<string, string>;
	try {
		keys = takeSecrets();
	} catch {
		throw new Refusal('no keys were handed over: run `bun run --bun probe`, which reads them with deploy/probes/secrets.ts');
	}
	const missing = KEYS.filter((k) => !keys.get(k));
	if (missing.length) throw new Refusal(`clerk-dev has no ${missing.join(', ')}`);
	rmSync(out, { force: true });

	const runId = randomBytes(3).toString('hex');
	const runDir = path.join(root, '.local', 'hosting-probe', 'identity', new Date().toISOString().replace(/[:.]/g, '-'));
	const logs = path.join(runDir, 'logs');
	const persist = path.join(runDir, 'persist');
	mkdirSync(logs, { recursive: true });
	const env = appEnv(node, runDir);
	/** Every value the run must never write anywhere: the keys, and each token, dev browser JWT, ticket and password it sees. */
	const canaries = new Set<string>(KEYS.map((k) => keys.get(k)!));
	const secret = <T extends string>(v: T): T => (v.length >= 12 && canaries.add(v), v);
	const fapi = { client: frontendApi(keys.get('CLIENT_A_PK')!), staff: frontendApi(keys.get('STAFF_PK')!) };
	const bapi = { client: new Backend(keys.get('CLIENT_A_SK')!, new Pace(40, 10_000)), staff: new Backend(keys.get('STAFF_SK')!, new Pace(40, 10_000)) };
	const prefix = `cc108-${runId}-`;
	const emailOf = (who: string) => `${prefix}${who}+clerk_test@example.com`;
	const clerk = { users: { created: 0, deleted: 0 }, invitations: { created: 0, deleted: 0 }, sessions: { created: 0, ended: 0, pending: 0 }, testingTokens: { created: 0 }, devBrowsers: { created: 0 } };
	const sessionIds: { app: AppName; id: string }[] = [];
	const baseline: Record<AppName, { users: number; pendingInvitations: number }> = { client: { users: 0, pendingInvitations: 0 }, staff: { users: 0, pendingInvitations: 0 } };

	const legs = Object.fromEntries(LEGS.map((n) => [n, { status: 'NOT RUN', asserted: [] } as Leg])) as Record<LegName, Leg>;
	async function leg(name: LegName, body: (check: (ok: boolean, what: string) => void) => Promise<void>) {
		const l: Leg = { status: 'FAIL', asserted: [] };
		legs[name] = l;
		try {
			await body((ok, what) => {
				if (!ok) throw new Error(`assertion failed: ${what}${lastReply ? ` (last reply: ${lastReply})` : ''}`);
				l.asserted.push(what);
			});
			l.status = 'PASS';
		} catch (e) {
			l.failure = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	// Requests to the probe Workers, paced so the Workers' session-status lookups stay inside Clerk's development limit.
	const appPace = new Pace(45, 10_000);
	/** The last Worker reply, for a failed check's message: status, denial and Clerk's reason only, never a body. */
	let lastReply: string | null = null;
	async function req(app: AppName, pathname: string, init: { token?: string; method?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string>; cookies?: Record<string, string> } = {}): Promise<Reply> {
		await appPace.take();
		const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
		let body: string | undefined;
		if (init.json !== undefined) (headers['content-type'] = 'application/json'), (body = JSON.stringify(init.json));
		if (init.form) (headers['content-type'] = 'application/x-www-form-urlencoded'), (headers['x-sveltekit-action'] = 'true'), (body = new URLSearchParams(init.form).toString());
		const r = await fetchApp(ORIGIN[app], pathname, { method: init.method ?? 'GET', headers, body, token: init.token, cookies: init.cookies });
		lastReply = `${app} ${init.method ?? 'GET'} ${pathname.split('?')[0]} ${r.status} ${r.denial ?? '-'} ${r.clerkReason ?? '-'}`;
		return r;
	}

	type Person = { name: string; app: AppName; email: string; password: string; browser: Browser; session: string; subject?: string };
	const people = new Map<string, Person>();
	async function browser(app: AppName, origin: string = ORIGIN[app]) {
		const tt = secret(await bapi[app].testingToken());
		clerk.testingTokens.created++;
		const b = await Browser.open(fapi[app], origin, tt);
		secret(b.devBrowser);
		clerk.devBrowsers.created++;
		return b;
	}
	const newSession = (p: { app: AppName }, id: string) => (clerk.sessions.created++, sessionIds.push({ app: p.app, id }), id);
	async function signUp(name: string, app: AppName, url: string): Promise<Person> {
		const b = await browser(app);
		const password = secret(randomBytes(18).toString('base64url'));
		const sid = await b.signUpWithTicket(secret(ticketOf(url) ?? ''), password);
		clerk.users.created++;
		const p: Person = { name, app, email: emailOf(name), password, browser: b, session: newSession({ app }, sid) };
		people.set(name, p);
		return p;
	}
	async function signIn(p: Person): Promise<{ browser: Browser; session: string }> {
		const b = await browser(p.app);
		return { browser: b, session: newSession(p, await b.signInWithEmailCode(p.email)) };
	}
	const token = async (p: { browser: Browser; session: string }) => secret(await p.browser.token(p.session));
	const person = (name: string) => people.get(name)!;

	/** Row counts of both apps' D1, read by a separate Wrangler process from the running Workers' state. */
	function snapshot(): Record<string, number> {
		const counts: Record<string, number> = {};
		const tables = { client: ['members', 'assignments', 'invitations', 'notes', 'operator_grants'], staff: ['members', 'invitations'] } as const;
		for (const app of ['client', 'staff'] as const) {
			const sql = tables[app].map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join(' UNION ALL ');
			const r = run(node.path, [path.join(HERE, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--local', '--env', app, '--persist-to', persist, '--json', '--command', sql], { env });
			if (r.code !== 0) throw new Error(`snapshot of ${app} D1 failed (exit ${r.code})`);
			for (const row of (JSON.parse(r.out.slice(r.out.indexOf('['))) as { results: { t: string; n: number }[] }[])[0]!.results) counts[`${app}.${row.t}`] = row.n;
		}
		return counts;
	}
	const delta = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(b).filter((k) => b[k] !== a[k]).map((k) => [k, b[k]! - a[k]!]));

	const startedAt = new Date().toISOString();
	let servedStamp: string | null = null;
	let artifact: string | null = null;
	let serve: ChildProcess | null = null;
	const instances: Record<string, unknown> = {};
	const routeTable: { app: string; method: string; route: string; gate: string; checks: { class: Class; expect: string; got: string; leak: string[]; missing: boolean }[] }[] = [];
	const serveConfig: ServeConfig = { persist, logs, mfaRequired: false, jwtKeys: false, client: { port: clientPort, origin: ORIGIN.client }, staff: { port: staffPort, origin: ORIGIN.staff } };
	const serveKeys = new Map(KEYS.map((k) => [k, keys.get(k)!]));
	let failure: string | null = null;
	let scanHits: number | null = null;
	let expiredTokens: { client: string; staff: string } | null = null;

	const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

	/**
	 * An earlier run that was killed before its cleanup leaves its `cc108-` users and invitations in the development
	 * instances. Removes those over an hour old (never this run's own, nor a concurrent run's), invitations before users.
	 * A failure is reported and the sweep goes on: it is housekeeping, not evidence.
	 */
	const swept = { users: 0, invitations: 0, failed: 0 };
	async function sweep(): Promise<void> {
		const cutoff = Date.now() - 3_600_000;
		for (const app of ['client', 'staff'] as const) {
			const stale = async <T extends { id: string; createdAt: number }>(kind: 'users' | 'invitations', list: () => Promise<T[]>, remove: (id: string) => Promise<unknown>) => {
				let found: T[] = [];
				try {
					found = await list();
				} catch (e) {
					swept.failed++;
					console.error(`sweep: listing ${app} ${kind} failed: ${describe(e)}`);
				}
				for (const row of found.filter((x) => x.createdAt < cutoff)) {
					try {
						await remove(row.id);
						swept[kind]++;
					} catch (e) {
						swept.failed++;
						console.error(`sweep: deleting a stale ${app} ${kind.slice(0, -1)} failed: ${describe(e)}`);
					}
				}
			};
			await stale('invitations', () => bapi[app].invitations('cc108-'), (id) => bapi[app].call('DELETE', `/invitations/${id}`));
			await stale('users', () => bapi[app].users('cc108-'), (id) => bapi[app].deleteUser(id));
		}
	}

	let cleanedUp: Promise<void> | null = null;
	/**
	 * Stops the Workers, deletes what this run made in both instances and checks that nothing is left. It runs once, from
	 * `finally` or from an interrupt, whichever comes first. Every object is tried and a failure does not stop the rest;
	 * the failures are reported together at the end.
	 */
	const cleanup = () =>
		(cleanedUp ??= leg('cleanup', async (check) => {
			const problems: string[] = [];
			const attempt = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
				try {
					await fn();
					return true;
				} catch (e) {
					problems.push(`${what}: ${describe(e)}`);
					return false;
				}
			};
			const verify = (ok: boolean, what: string) => (ok ? check(true, what) : void problems.push(`not so: ${what}`));
			if (serve) {
				const s = serve;
				serve = null;
				await attempt('stopping serve.mjs', async () => void (await stopServe(s)));
			}
			// invitations first: deleting a user also removes the invitation it accepted
			for (const app of ['client', 'staff'] as const) {
				let invitations: Awaited<ReturnType<Backend['invitations']>> = [];
				await attempt(`listing ${app} invitations`, async () => void (invitations = await bapi[app].invitations(prefix)));
				for (const i of invitations) await attempt(`deleting a ${app} invitation`, async () => (await bapi[app].call('DELETE', `/invitations/${i.id}`), void clerk.invitations.deleted++));
				let users: Awaited<ReturnType<Backend['users']>> = [];
				await attempt(`listing ${app} users`, async () => void (users = await bapi[app].users(prefix)));
				for (const u of users) await attempt(`deleting a ${app} user`, async () => (await bapi[app].deleteUser(u.id), void clerk.users.deleted++));
			}
			// each session's own status: gone (404), or any status but active; a pending session is counted apart and fails the check
			let ended = 0;
			let pending = 0;
			for (const s of sessionIds) {
				let status = 'gone';
				const read = await attempt(`reading a ${s.app} session`, async () => {
					try {
						status = (await bapi[s.app].getSession(s.id)).status;
					} catch (e) {
						if (!(e instanceof ClerkError && e.status === 404)) throw e;
					}
				});
				if (!read) continue;
				if (status === 'active') problems.push(`a ${s.app} session the run created is still active after its user was deleted`);
				else if (status === 'pending') pending++;
				else ended++;
			}
			clerk.sessions.ended = ended;
			clerk.sessions.pending = pending;
			verify(ended === sessionIds.length && pending === 0, `all ${sessionIds.length} sessions the run created are gone or ended (${ended} ended, ${pending} pending)`);
			for (const app of ['client', 'staff'] as const) {
				await attempt(`checking ${app}`, async () => {
					verify((await bapi[app].users(prefix)).length === 0 && (await bapi[app].invitations(prefix)).length === 0, `${app}: no user or invitation of this run is left in Clerk`);
					verify((await bapi[app].usersCount()) === baseline[app].users && (await bapi[app].pendingInvitations()) === baseline[app].pendingInvitations, `${app}: the user count and pending invitations are back to the run's baseline`);
				});
			}
			verify(clerk.users.created === clerk.users.deleted && clerk.invitations.created === clerk.invitations.deleted, `created ${clerk.users.created} users and ${clerk.invitations.created} invitations; deleted the same`);
			check(problems.length === 0, `every object of the run was deleted or ended${problems.length ? `; ${problems.length} problem(s): ${problems.slice(0, 8).join('; ')}` : ''}`);
		}));
	// SIGINT or SIGTERM (Ctrl-C, a timeout, a killed terminal): the Workers stop and Clerk is cleaned before the process ends
	onInterrupt(async () => {
		failure ??= 'interrupted by a signal';
		try {
			await cleanup();
		} catch (e) {
			console.error(`cleanup after the signal: ${describe(e)}`);
		}
		console.error(`interrupted: clerk users ${clerk.users.created}/${clerk.users.deleted} invitations ${clerk.invitations.created}/${clerk.invitations.deleted} sessions ${clerk.sessions.created}/${clerk.sessions.ended} (created/deleted or ended)`);
	});
	await sweep();
	console.log(`sweep: removed ${swept.users} users and ${swept.invitations} invitations of earlier runs older than an hour${swept.failed ? `; ${swept.failed} failed (see above)` : ''}`);

	try {
		await leg('integration', async (check) => {
			rmSync(path.join(HERE, '.svelte-kit'), { recursive: true, force: true });
			const log = build(node, runDir, sha, bun);
			check(log.includes(`[probe build host] {"bun":"${BUN}"`), `the SvelteKit build (adapter-cloudflare) ran under Bun ${BUN}`);
			const stamp = JSON.parse(readFileSync(path.join(HERE, '.svelte-kit/cloudflare/_app/version.json'), 'utf8')) as { version?: string };
			check(stamp.version === sha, 'the build is stamped with HEAD');
			const server = readdirSync(path.join(HERE, '.svelte-kit/output/server'), { recursive: true }).map(String).filter((f) => f.endsWith('.js'));
			const bundle = server.map((f) => readFileSync(path.join(HERE, '.svelte-kit/output/server', f), 'utf8')).join('\n');
			check(bundle.includes('authenticateRequest') && bundle.includes('clerk'), "@clerk/backend's authenticateRequest is in the server bundle");
			check(!/from\s*["']node:crypto["']|require\(["']node:crypto["']\)/.test(bundle), '@clerk/backend resolved its worker build: no node:crypto import in the server bundle');
			const h = createHash('sha256');
			for (const f of server.sort()) h.update(`${f}\0`).update(readFileSync(path.join(HERE, '.svelte-kit/output/server', f))).update('\0');
			artifact = `sha256:${h.digest('hex')}`;
			const provision = path.join(runDir, 'provision');
			mkdirSync(provision);
			const ga = emailOf('ga');
			const at = '2026-01-01T00:00:00.000Z';
			const exp = new Date(Date.now() + 24 * 3600_000).toISOString();
			// The deployer's provisioning step: the staff app's initial Global Admin, and client A's instance admin.
			writeFileSync(path.join(provision, 'staff.sql'), `INSERT INTO invitations (app, email, role, expires_at, created_by, created_at) VALUES ('staff', '${ga}', 'global_admin', '${exp}', 'provisioning', '${at}');\n`);
			writeFileSync(path.join(provision, 'client.sql'), `INSERT INTO invitations (app, email, role, expires_at, created_by, created_at) VALUES ('staff', '${ga}', 'instance_admin', '${exp}', 'provisioning', '${at}');\n`);
			seed(node, env, persist, logs, { client: ['schema/common.sql', 'schema/client.sql', 'schema/fixtures.sql', path.join(provision, 'client.sql')], staff: ['schema/common.sql', path.join(provision, 'staff.sql')] });
			check(true, 'wrangler d1 execute --local and wrangler r2 object put --local seeded both apps (a separate process from the Workers)');
			serve = await startServe(node, env, serveConfig, serveKeys, logs);
			check(true, 'serve.mjs (Node) started both Workers through Wrangler startWorker with the keys from fd 3 as secret_text bindings');
			check(descendants(serve.pid!).filter((exe) => exe === 'workerd').length >= 2, "native workerd processes, descendants of serve.mjs, serve the Workers");
			for (const app of ['client', 'staff'] as const) {
				const home = await req(app, '/', { headers: { accept: 'text/html' } });
				check(home.status === 200 && home.body.includes('data-entry="home"'), `${app}: GET / answers the public home page`);
				const v = await req(app, '/_app/version.json');
				servedStamp = (JSON.parse(v.body) as { version?: string }).version ?? null;
				check(v.status === 200 && servedStamp === sha, `${app}: /_app/version.json serves the HEAD stamp`);
			}
		});

		await leg('instances', async (check) => {
			for (const app of ['client', 'staff'] as const) {
				const res = await fetch(`${fapi[app]}/v1/environment`, { signal: AbortSignal.timeout(30_000) });
				const e = (await res.json()) as any;
				const us = e.user_settings ?? {};
				const name = app === 'client' ? 'Clear-Case-Dev-A' : 'Clear-Case-Dev-B';
				check(res.status === 200 && e.display_config?.application_name === name && e.display_config?.instance_environment_type === 'development', `${app}: the Frontend API is the development instance ${name}`);
				check(us.sign_up?.mode === 'restricted', `${app}: sign-up mode is restricted (invite-only)`);
				check(us.sign_up?.mfa?.required === false && us.sign_in?.second_factor?.required === false, `${app}: MFA is not required at sign-up or sign-in`);
				const second = Object.entries(us.attributes ?? {}).filter(([, a]: [string, any]) => a.enabled && a.used_for_second_factor).map(([k]) => k);
				check(second.length === 0, `${app}: no attribute is enabled as a second factor`);
				baseline[app] = { users: await bapi[app].usersCount(), pendingInvitations: await bapi[app].pendingInvitations() };
				const b = await browser(app);
				let refused: string | null = null;
				try {
					await b.signUpOpen(emailOf(`open-${app}`), secret(randomBytes(18).toString('base64url')));
				} catch (err) {
					refused = err instanceof ClerkError ? err.code : null;
				}
				check(refused === 'sign_up_mode_restricted', `${app}: a sign-up with no invitation is refused by Clerk (403 sign_up_mode_restricted)`);
				instances[app] = { name, environment: 'development', signUpMode: 'restricted', mfaRequired: false, secondFactors: 0, captcha: us.sign_up?.captcha_enabled === true };
			}
		});

		await leg('invite-only', async (check) => {
			// The initial Global Admin: the deployer creates the staff invitation (no admin exists yet to do it in the app).
			const inv = await bapi.staff.createInvitation(emailOf('ga'), `${ORIGIN.staff}/login`);
			clerk.invitations.created++;
			const ga = await signUp('ga', 'staff', inv.url);
			let t = await token(ga);
			const before = await req('staff', '/auth/session', { token: t });
			check(before.status === 200 && JSON.parse(before.body).role === null, 'staff: a signed-up Global Admin has a session but no role until enrolled');
			const blocked = await req('staff', '/manage/staff', { token: t });
			check(blocked.status === 403 && blocked.denial === 'global-admin-required', 'staff: before enrolment the Global Admin routes refuse (403)');
			const acc = await req('staff', '/invite/accept', { token: t, method: 'POST', json: {} });
			check(acc.status === 201 && JSON.parse(acc.body).role === 'global_admin', "staff: /invite/accept enrols the initial Global Admin from the deployer's D1 invitation");
			const again = await req('staff', '/invite/accept', { token: t, method: 'POST', json: {} });
			check(again.status === 409 && again.denial === 'already-a-member', 'staff: a second accept is refused (409)');
			ga.subject = claimsOf(t).sub as string;
			const onClient = await req('client', '/manage/accept', { token: t, method: 'POST', json: {} });
			check(onClient.status === 201 && JSON.parse(onClient.body).role === 'instance_admin', "client: the Global Admin's staff session takes up client A's provisioning invitation (instance admin)");
			// Staff: the Global Admin invites an operator in the app.
			const opInv = await req('staff', '/manage/staff-invitations', { token: t, method: 'POST', json: { email: emailOf('operator') } });
			clerk.invitations.created++;
			check(opInv.status === 201, 'staff: the Global Admin invites an operator (Clerk invitation through @clerk/backend in the Worker)');
			const op = await signUp('operator', 'staff', secret(JSON.parse(opInv.body).url));
			const opT = await token(op);
			const opAcc = await req('staff', '/invite/accept', { token: opT, method: 'POST', json: {} });
			check(opAcc.status === 201 && JSON.parse(opAcc.body).role === 'operator', 'staff: the operator accepts and is enrolled as operator');
			op.subject = claimsOf(opT).sub as string;
			const opAdmin = await req('staff', '/manage/staff-invitations', { token: opT, method: 'POST', json: { email: emailOf('nobody') } });
			check(opAdmin.status === 403 && opAdmin.denial === 'global-admin-required', 'staff: an operator cannot invite (403)');
			// Client A: the instance admin invites the first firm admin; the firm admin invites users.
			t = await token(ga);
			const faInv = await req('client', '/manage/firm-admin-invitations', { token: t, method: 'POST', json: { email: emailOf('firmadmin') } });
			clerk.invitations.created++;
			check(faInv.status === 201, "client: the Global Admin (instance admin) invites client A's first firm admin through Dev-A");
			const fa = await signUp('firmadmin', 'client', secret(JSON.parse(faInv.body).url));
			let faT = await token(fa);
			const faAcc = await req('client', '/invite/accept', { token: faT, method: 'POST', json: {} });
			check(faAcc.status === 201 && JSON.parse(faAcc.body).role === 'firm_admin', 'client: the firm admin accepts and is enrolled as firm admin');
			fa.subject = claimsOf(faT).sub as string;
			for (const who of ['viewer1', 'editor1', 'viewer2']) {
				faT = await token(fa);
				const i = await req('client', '/admin/invitations', { token: faT, method: 'POST', json: { email: emailOf(who) } });
				clerk.invitations.created++;
				check(i.status === 201, `client: the firm admin invites ${who}`);
				const p = await signUp(who, 'client', secret(JSON.parse(i.body).url));
				const pt = await token(p);
				const a = await req('client', '/invite/accept', { token: pt, method: 'POST', json: {} });
				check(a.status === 201 && JSON.parse(a.body).role === 'member', `client: ${who} accepts and is enrolled as member`);
				p.subject = claimsOf(pt).sub as string;
				const none = await req('client', '/cases', { token: pt });
				check(none.status === 200 && !MARKERS.some((m) => none.body.includes(m)), `client: ${who} sees no case before an assignment`);
			}
			faT = await token(fa);
			for (const [who, c, role] of [['viewer1', 'case-1', 'viewer'], ['editor1', 'case-1', 'editor'], ['viewer2', 'case-2', 'viewer']] as const) {
				const a = await req('client', '/admin/assignments', { token: faT, method: 'POST', json: { subject: person(who).subject, case: c, role } });
				check(a.status === 201, `client: the firm admin assigns ${who} to ${c} as ${role}`);
			}
			// A Clerk user with no app invitation (created by the Backend API, as a dashboard admin could) gets no membership.
			for (const app of ['client', 'staff'] as const) {
				const name = `outsider-${app}`;
				const password = secret(randomBytes(18).toString('base64url'));
				await bapi[app].createUser(emailOf(name), password);
				clerk.users.created++;
				const p: Person = { name, app, email: emailOf(name), password, browser: null as unknown as Browser, session: '' };
				const s = await signIn(p);
				Object.assign(p, s);
				people.set(name, p);
				const ot = await token(p);
				p.subject = claimsOf(ot).sub as string;
				const acc2 = await req(app, '/invite/accept', { token: ot, method: 'POST', json: {} });
				check(acc2.status === 403 && acc2.denial === 'no-invitation', `${app}: a Clerk user with no app invitation, signed in by email code, cannot enrol (403 no-invitation)`);
			}
			const cases = await req('client', '/cases', { token: await token(person('outsider-client')) });
			check(cases.status === 403 && cases.denial === 'not-a-member', 'client: that user reads no case list (403 not-a-member)');
		});

		await leg('grants-outside-clerk', async (check) => {
			for (const p of people.values()) {
				const u = await bapi[p.app].getUser(p.subject!);
				check(JSON.stringify([u.public_metadata, u.private_metadata, u.unsafe_metadata]) === '[{},{},{}]', `${p.app}: ${p.name}'s Clerk user has empty public, private and unsafe metadata`);
				check(u.two_factor_enabled === false, `${p.app}: ${p.name} has no second factor (MFA off)`);
				const claims = claimsOf(await token(p));
				const keysOf = Object.keys(claims).sort();
				check(keysOf.every((k) => CLAIMS.includes(k)) && !JSON.stringify(claims).includes('case-'), `${p.app}: ${p.name}'s session token has only Clerk's v2 claims and no case id`);
			}
			for (const app of ['client', 'staff'] as const) {
				const invs = await bapi[app].invitations(prefix);
				for (const i of invs) {
					const full = await bapi[app].call('GET', `/invitations?limit=100&query=${encodeURIComponent(i.email)}`);
					const row = (Array.isArray(full) ? full : full.data).find((x: any) => x.id === i.id);
					check(JSON.stringify(row?.public_metadata ?? null) === '{}', `${app}: the Clerk invitation for ${i.email.slice(prefix.length).split('+')[0]} carries no metadata`);
				}
			}
			const counts = snapshot();
			check(counts['client.assignments'] === 3 && counts['client.members'] === 5 && counts['staff.members'] === 2, "case assignments (3) and memberships live in the apps' own D1, not in Clerk");
		});

		await leg('operator-access', async (check) => {
			const ga = person('ga');
			const op = person('operator');
			let gaT = await token(ga);
			const opT0 = await token(op);
			const before = await req('client', '/operator/cases/case-1', { token: opT0 });
			check(before.status === 403 && before.denial === 'no-operator-grant' && !MARKERS.some((m) => before.body.includes(m)), 'client: an operator with no grant reads nothing of case 1 (403)');
			const gaSelf = await req('client', '/operator/cases/case-1', { token: gaT });
			check(gaSelf.status === 403 && gaSelf.denial === 'no-operator-grant', 'client: the Global Admin itself has no case content without a grant (403)');
			const fa = await req('client', '/cases/case-1', { token: await token(person('firmadmin')) });
			check(fa.status === 404 && fa.denial === 'no-case-access' && !MARKERS.some((m) => fa.body.includes(m)), 'client: the firm admin has no case content without an assignment (404)');
			const g = await req('client', '/manage/operator-grants', { token: gaT, method: 'POST', json: { subject: op.subject, case: 'case-1', seconds: 600 } });
			check(g.status === 201, 'client: the Global Admin grants the operator case 1 for 10 minutes');
			const short = await req('client', '/manage/operator-grants', { token: gaT, method: 'POST', json: { subject: op.subject, case: 'case-2', seconds: 20 } });
			check(short.status === 201, 'client: and case 2 for 20 seconds (the expiry leg replays it later)');
			const unknown = await req('client', '/manage/operator-grants', { token: gaT, method: 'POST', json: { subject: 'user_cc108unenrolled', case: 'case-1', seconds: 600 } });
			check(unknown.status === 404, 'client: a grant to a subject that is no user of the staff instance (Dev-B) is refused (404)');
			const opT = await token(op);
			const meta = await req('client', '/operator/cases/case-1', { token: opT });
			check(meta.status === 200 && meta.body.includes('CC108-CASE1-META') && !meta.body.includes('CC108-CASE2'), 'client: the operator reads case 1 metadata under the grant');
			const draft = await req('client', '/operator/cases/case-1/drafts/candidate.txt', { token: opT });
			check(draft.status === 200 && draft.body.includes('CC108-CASE1-DRAFT'), "client: the operator reads case 1's draft asset under the grant");
			const clientDraft = await req('client', '/cases/case-1/assets/candidate.txt', { token: await token(person('viewer1')) });
			check(clientDraft.status === 404 && !clientDraft.body.includes('DRAFT'), "client: an assigned viewer cannot reach the draft through the published-asset route (404)");
			const other = await req('client', '/cases/case-1/documents/doc-2', { token: await token(person('viewer1')) });
			check(other.status === 404 && !other.body.includes('CC108-CASE2'), "client: case 2's document id under a case-1 URL answers 404");
			gaT = await token(ga);
			const audit = await req('client', '/manage/audit', { token: gaT });
			const events = (JSON.parse(audit.body) as { events: { subject: string | null; action: string; case_id: string | null; outcome: string }[] }).events;
			check(audit.status === 200 && !MARKERS.some((m) => audit.body.includes(m)), 'client: the Global Admin reads the audit, which holds no case content');
			check(events.some((e) => e.subject === op.subject && e.action === 'GET /operator/cases/[case]' && e.case_id === 'case-1' && e.outcome === 'allowed'), "client: the operator's granted read is an audit event (actor, route, case, outcome)");
			check(events.some((e) => e.subject === op.subject && e.case_id === 'case-1' && e.outcome === 'denied:no-operator-grant'), "client: the operator's refused read before the grant is an audit event");
			check(events.some((e) => e.subject === ga.subject && e.action === 'POST /manage/operator-grants' && e.outcome === 'allowed'), 'client: each grant is an audit event naming the Global Admin');
			check(events.some((e) => e.subject === ga.subject && e.case_id === 'case-1' && e.outcome === `grant:${op.subject}`), "client: the grant itself is an audit event naming the case and the operator, written in the grant's transaction");
			check(events.some((e) => e.subject === person('firmadmin').subject && e.outcome === 'denied:no-case-access'), "client: the firm admin's refused case read is an audit event");
			check(events.some((e) => e.subject === ga.subject && e.case_id === 'case-1' && e.outcome === 'denied:unknown-grantee') && !events.some((e) => e.outcome === 'grant:user_cc108unenrolled'), "client: the refused grant is an audit event naming the Global Admin and the case, and no grant row was written for that subject");
			const faAudit = await req('client', '/manage/audit', { token: await token(person('firmadmin')) });
			check(faAudit.status === 401, "client: a firm admin's client session cannot read the audit (401)");
		});

		await leg('revocation', async (check) => {
			const v2 = person('viewer2');
			// The app's sign-out: Clerk revokes the session, and the same unexpired token is refused at once.
			const t = await token(v2);
			const ok = await req('client', '/cases/case-2', { token: t });
			check(ok.status === 200 && ok.body.includes('CC108-CASE2-META'), 'client: viewer2 reads case 2 with a fresh token');
			const out = await req('client', '/auth/sign-out', { token: t, method: 'POST', json: {} });
			check(out.status === 200, 'client: POST /auth/sign-out revokes the session in Clerk');
			const replay = await req('client', '/cases/case-2', { token: t });
			const age = Math.floor(Date.now() / 1000) - (claimsOf(t).iat as number);
			check(replay.status === 401 && replay.denial === 'session-revoked' && !replay.body.includes('CC108'), `client: the same token, ${age} s old and unexpired, is refused at once (401 session-revoked)`);
			let refresh: string | null = null;
			try {
				await v2.browser.token(v2.session);
			} catch (e) {
				refresh = e instanceof ClerkError ? `${e.status}` : 'error';
			}
			check(refresh !== null, `client: Clerk refuses a new token for the revoked session (FAPI ${refresh})`);
			// Revocation outside the app (the Backend API, as the dashboard does): refused on the next request.
			const e1 = person('editor1');
			const second = await signIn(e1);
			const t2 = await token(second);
			const before = await req('client', '/cases/case-1/notes', { token: t2 });
			check(before.status === 200, 'client: editor1 reads case 1 Notes on a second session');
			await bapi.client.revokeSession(second.session);
			const after = await req('client', '/cases/case-1/notes', { token: t2 });
			check(after.status === 401 && after.denial === 'session-revoked', 'client: after a Backend API revoke, the same unexpired token is refused on its next request');
			const write = await req('client', '/cases/case-1/notes', { token: t2, method: 'POST', json: { requestId: `revoked-${runId}`, body: 'synthetic note' } });
			check(write.status === 401 && write.denial === 'session-revoked', 'client: and so is its mutation');
			// Grant removal with an active session.
			const v1 = person('viewer1');
			const fa = person('firmadmin');
			await req('client', '/admin/assignments', { token: await token(fa), method: 'DELETE', json: { subject: v1.subject, case: 'case-1' } });
			const gone = await req('client', '/cases/case-1', { token: await token(v1) });
			check(gone.status === 404 && gone.denial === 'no-case-access' && !gone.body.includes('CC108'), "client: after the firm admin removes viewer1's assignment, viewer1's active session reads nothing of case 1 (404)");
			const back = await req('client', '/admin/assignments', { token: await token(fa), method: 'POST', json: { subject: v1.subject, case: 'case-1', role: 'viewer' } });
			check(back.status === 201, 'client: the assignment is restored for the matrix');
		});

		await leg('expiry-and-recovery', async (check) => {
			const e1 = person('editor1');
			const v1 = person('viewer1');
			const gaOld = await token(person('ga'));
			const old = await token(e1);
			const v1Old = await token(v1);
			const iat = claimsOf(old).iat as number;
			const exp = claimsOf(old).exp as number;
			check(exp - iat === 60, 'client: Clerk development session tokens live 60 s');
			(instances.client as Record<string, unknown>).tokenSeconds = exp - iat;
			(instances.staff as Record<string, unknown>).tokenSeconds = (claimsOf(gaOld).exp as number) - (claimsOf(gaOld).iat as number);
			const notes0 = snapshot()['client.notes']!;
			// Wait past expiry and Clerk's 5 s clock skew.
			await sleep(Math.max(0, (exp + 7) * 1000 - Date.now()));
			const expired = await req('client', '/cases/case-1', { token: old });
			check(expired.status === 401 && expired.denial === 'token-expired' && !expired.body.includes('CC108'), 'client: a token past exp (and the 5 s skew) is refused (401 token-expired)');
			const requestId = `recovery-${runId}`;
			const w1 = await req('client', '/cases/case-1/notes', { token: old, method: 'POST', json: { requestId, body: 'synthetic note written across an expiry' } });
			check(w1.status === 401 && w1.denial === 'token-expired' && snapshot()['client.notes'] === notes0, 'client: a Note posted with the expired token is refused and nothing is written');
			const fresh = await token(e1);
			check(claimsOf(fresh).sid === e1.session, 'client: the browser refreshes the same session through FAPI, with no new sign-in');
			const w2 = await req('client', '/cases/case-1/notes', { token: fresh, method: 'POST', json: { requestId, body: 'synthetic note written across an expiry' } });
			check(w2.status === 201 && JSON.parse(w2.body).replayed === false, 'client: the retried Note is saved (201)');
			const w3 = await req('client', '/cases/case-1/notes', { token: fresh, method: 'POST', json: { requestId, body: 'synthetic note written across an expiry' } });
			check(w3.status === 200 && JSON.parse(w3.body).replayed === true && snapshot()['client.notes'] === notes0 + 1, 'client: a second retry after a lost response returns the first save (200 replayed): one Note');
			expiredTokens = { client: v1Old, staff: gaOld };
			const opExpired = await req('client', '/operator/cases/case-2', { token: await token(person('operator')) });
			check(opExpired.status === 403 && opExpired.denial === 'no-operator-grant', "client: the operator's 20-second grant for case 2 has expired (403)");
			// The browser's own recovery: a document request with an expired __session cookie gets Clerk's handshake.
			const jar: Record<string, string> = { __session: v1Old, __client_uat: String(iat), __clerk_db_jwt: v1.browser.devBrowser };
			const doc = await req('client', '/cases/case-1', { cookies: jar, headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
			const to = doc.location ? new URL(doc.location, ORIGIN.client) : null;
			check(doc.status === 307 && to?.origin === fapi.client && to.pathname === '/v1/client/handshake', 'client: a document request with an expired __session cookie is redirected to the Frontend API handshake (307)');
			check(!doc.body.includes('CC108'), 'client: the handshake redirect carries no case content');
			// Follow it as the browser would: the dev browser JWT names the Clerk client that holds the session.
			let hop = await fetch(to!, { redirect: 'manual', headers: { origin: ORIGIN.client }, signal: AbortSignal.timeout(30_000) });
			let back = hop.headers.get('location');
			check(hop.status >= 300 && hop.status < 400 && !!back && new URL(back).origin === ORIGIN.client, 'client: the Frontend API answers the handshake with a redirect back to the app');
			let cookies = { ...jar };
			for (let i = 0; i < 4 && back && new URL(back).origin === ORIGIN.client; i++) {
				const u = new URL(back);
				const r = await req('client', `${u.pathname}${u.search}`, { cookies, headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
				for (const c of r.headers.getSetCookie()) {
					const [pair] = c.split(';');
					const eq = pair!.indexOf('=');
					const name = pair!.slice(0, eq);
					const value = pair!.slice(eq + 1);
					if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) delete cookies[name];
					else cookies = { ...cookies, [name]: secret(value) };
				}
				if (r.status === 200) {
					check(r.body.includes('CC108-CASE1-META') && cookies.__session !== v1Old, 'client: the app takes the handshake, sets a fresh __session cookie, and serves case 1 with no new sign-in');
					back = null;
					break;
				}
				back = r.location ? new URL(r.location, ORIGIN.client).toString() : null;
				if (back && new URL(back).origin !== ORIGIN.client) {
					hop = await fetch(back, { redirect: 'manual', headers: { origin: ORIGIN.client }, signal: AbortSignal.timeout(30_000) });
					back = hop.headers.get('location');
				}
			}
			check(back === null, 'client: the handshake round trip ended on the requested page');
			const relogin = await req('client', '/login?reason=session-revoked&next=/cases/case-1', { headers: { accept: 'text/html' } });
			check(relogin.status === 200 && relogin.body.includes('data-reason="session-revoked"'), 'client: a revoked session, which cannot refresh, lands on the sign-in entry with its reason (BA-19)');
		});

		await leg('restart', async (check) => {
			const ended = await stopServe(serve!);
			serve = null;
			check(ended === 'SIGINT' || ended === 'SIGTERM', `serve.mjs and its workerd processes stopped on ${ended}`);
			serve = await startServe(node, env, serveConfig, serveKeys, logs);
			const e1 = person('editor1');
			const t = await token(e1);
			check(claimsOf(t).sid === e1.session, "after the Workers restart, editor1's same Clerk session mints a token with no new sign-in");
			const notes = await req('client', '/cases/case-1/notes', { token: t });
			check(notes.status === 200 && notes.body.includes('synthetic note written across an expiry'), 'the Note saved before the restart is still there (local D1 persisted)');
		});

		await leg('route-matrix', async (check) => {
			const all = rows();
			const fa = person('firmadmin');
			const ga = person('ga');
			const v1 = person('viewer1');
			// Tokens for each class, minted just before its sweep (they live 60 s); the expired ones are the expiry leg's.
			const tokens = async (cls: Class): Promise<{ client: string | null; staff: string | null }> => {
				switch (cls) {
					case 'anonymous':
						return { client: null, staff: null };
					case 'expired':
						if (!expiredTokens) throw new Error('expired class: the expiry leg left no expired tokens');
						return expiredTokens;
					case 'revoked': {
						const c = await signIn(person('viewer2'));
						const ct = await token(c);
						const a = await req('client', '/auth/sign-out', { token: ct, method: 'POST', json: {} });
						const s = await signIn(ga);
						const st = await token(s);
						const b = await req('staff', '/auth/sign-out', { token: st, method: 'POST', json: {} });
						if (a.status !== 200 || b.status !== 200) throw new Error('revoked class: a sign-out did not answer 200');
						return { client: ct, staff: st };
					}
					case 'wrong-app':
						// the other instance's valid token: staff on the client's own routes, a client user on staff routes
						return { client: await token(ga), staff: await token(v1) };
					case 'wrong-party': {
						// the right instance, minted by a browser on the other app's origin: azp names the wrong app
						const cb = await browser('client', ORIGIN.staff);
						const cs = newSession(v1, await cb.signInWithEmailCode(v1.email));
						const sb = await browser('staff', ORIGIN.client);
						const ss = newSession(ga, await sb.signInWithEmailCode(ga.email));
						return { client: await token({ browser: cb, session: cs }), staff: await token({ browser: sb, session: ss }) };
					}
					case 'non-member':
						return { client: await token(person('outsider-client')), staff: null };
					case 'wrong-case':
						return { client: await token(await signIn(person('viewer2'))), staff: null };
					case 'firm-admin':
						return { client: await token(fa), staff: null };
					case 'viewer':
						return { client: await token(v1), staff: null };
					case 'editor':
						return { client: await token(person('editor1')), staff: null };
					case 'operator':
						return { client: null, staff: await token(person('operator')) };
					case 'global-admin':
						return { client: null, staff: await token(ga) };
				}
			};
			const table = new Map(all.map((r) => [`${r.app} ${r.method} ${r.route}`, { app: r.app, method: r.method, route: r.route, gate: r.gate, checks: [] as (typeof routeTable)[number]['checks'] }]));
					let n = 0;
			const deltaProblems: string[] = [];
			for (const cls of CLASS_ORDER) {
				const t = await tokens(cls);
				const before = snapshot();
				for (const r of all.filter((x) => classesOf(x).includes(cls))) {
					const credential = r.gate === 'public' ? (cls === 'anonymous' ? null : t.client ?? t.staff) : ownInstance(r) === 'client' ? t.client : t.staff;
					const e = expectFor(r, cls);
					const p = pathOf(r);
					const body = r.method === 'GET' ? {} : r.route === '/cases/[case]' ? { form: { requestId: `matrix-form-${cls}-${runId}`, body: 'synthetic matrix note' } } : { json: bodyFor(r, cls) };
					const headers = r.route.includes('[...name]') ? { range: 'bytes=0-9', 'if-none-match': '*' } : undefined;
					const res = await req(r.app, p, { token: credential ?? undefined, method: r.method, headers, ...body });
					if (res.status === 201 && r.route.endsWith('invitations')) clerk.invitations.created++;
					const got = { status: res.status, reason: res.status >= 400 ? (res.denial ?? `untagged:${res.status}`) : '' };
					const seen = MARKERS.filter((m) => res.body.includes(m));
					const permitted = mayShow(r, cls);
					table.get(`${r.app} ${r.method} ${r.route}`)!.checks.push({ class: cls, expect: label(e), got: label(got), leak: seen.filter((m) => !permitted.includes(m)), missing: e.marker !== null && !res.body.includes(e.marker) });
					n++;
				}
				const changed = delta(before, snapshot());
				const allowedDelta: Partial<Record<Class, Record<string, number>>> = {
					'firm-admin': { 'client.invitations': 1 },
					editor: { 'client.notes': 2 },
					'global-admin': { 'client.invitations': 1, 'client.operator_grants': 1, 'staff.invitations': 1 },
				};
				if (JSON.stringify(changed) !== JSON.stringify(allowedDelta[cls] ?? {})) deltaProblems.push(`${cls} changed ${JSON.stringify(changed)}, not ${JSON.stringify(allowedDelta[cls] ?? {})}`);
			}
			routeTable.push(...table.values());
			check(deltaProblems.length === 0, `each class changed D1 by exactly its allowed writes (firm admin one invitation, editor two Notes, Global Admin two invitations and one grant; refused requests change nothing)${deltaProblems.length ? `; ${deltaProblems.join('; ')}` : ''}`);
			const bad = routeTable.flatMap((r) => r.checks.filter((c) => c.got !== c.expect || c.leak.length || c.missing).map((c) => `${r.app} ${r.method} ${r.route} as ${c.class}: expected ${c.expect}, got ${c.got}${c.leak.length ? `, leaked ${c.leak.join(',')}` : ''}${c.missing ? ', missing its marker' : ''}`));
			check(bad.length === 0, `all ${n} route checks met their gate${bad.length ? `; ${bad.length} did not: ${bad.slice(0, 6).join('; ')}` : ''}`);
		});

		await leg('public-entry', async (check) => {
			for (const [app, paths] of [['client', ['/', '/login', '/support', '/information-handling']], ['staff', ['/', '/login']]] as const) {
				for (const p of paths) {
					const r = await req(app, p, { headers: { accept: 'text/html' }, cookies: { __session: 'synthetic-invalid-session-cookie' } });
					check(r.status === 200 && r.body.includes('data-entry=') && r.headers.getSetCookie().length === 0 && !r.body.includes('CC108'), `${app}: GET ${p} answers 200 logged out, with a stale cookie, sets no cookie and carries no case content`);
				}
			}
			// A development instance first gives a browser with no dev browser JWT one, through the Frontend API handshake.
			const fresh = await req('client', '/cases/case-1', { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
			const to = fresh.location ? new URL(fresh.location, ORIGIN.client) : null;
			check(fresh.status === 307 && to?.origin === fapi.client && to.pathname === '/v1/client/handshake' && !fresh.body.includes('CC108'), 'client: a logged-out document request from a browser with no __clerk_db_jwt goes to the Frontend API handshake first (307, development instances only), with no case content');
			const signedOutBrowser = await browser('client');
			const bounce = await req('client', '/cases/case-1', { cookies: { __clerk_db_jwt: signedOutBrowser.devBrowser, __client_uat: '0' }, headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
			check(bounce.status === 303 && bounce.location === '/login?reason=signed-out&next=%2Fcases%2Fcase-1', 'client: a logged-out document request from a browser that has its dev browser is sent to the sign-in entry with its reason and return path (BA-19)');
			const evil = await req('client', '/login?next=//evil.invalid/x', { headers: { accept: 'text/html' } });
			check(evil.status === 200 && evil.body.includes('data-next="/"'), 'client: /login refuses an off-site return path');
			for (const p of ['/support', '/information-handling']) {
				const r = await req('client', p, { headers: { accept: 'text/html' } });
				check(r.body.includes('data-copy="placeholder-for-review"'), `client: ${p} carries placeholder copy marked for review, not invented content (BA-20)`);
			}
		});
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e);
	} finally {
		try {
			await cleanup();
		} catch (e) {
			failure ??= describe(e);
		}
	}

	const endSha = head();
	const clean = !dirty();
	const summary: Record<string, unknown> = {
		schema: SCHEMA,
		sourceSha: sha,
		inputs: { paths: INPUT_PATHS, digest: inputsDigest(sha) },
		treeClean: clean && endSha === sha,
		servedStamp,
		startedAt,
		finishedAt: new Date().toISOString(),
		runDir: path.relative(root, runDir),
		hosts: { bun: bunVersion, node: node.version, build: `Bun ${BUN}`, runner: `Node ${process.versions.node}`, wrangler: `Node ${node.version}`, app: `workerd ${pins.workerd} (native)` },
		pins,
		artifact,
		instances,
		legs,
		routes: routeTable,
		counts: countsOf(routeTable),
		clerk: { ...clerk, apiCalls: { backend: bapi.client.calls + bapi.staff.calls } },
		hold: HOLD,
		failure,
		evidence: false,
	};
	try {
		await leg('credential-scan', async (check) => {
			writeFileSync(path.join(runDir, 'summary-draft.json'), JSON.stringify(summary));
			// Bun's transpiler cache holds installed packages' code (their PEM test fixtures match the private-key shape); it is not an output
			const roots = readdirSync(runDir).flatMap((d) => (d === 'cache' ? readdirSync(path.join(runDir, d)).filter((c) => c !== 'bun').map((c) => path.join(runDir, d, c)) : [path.join(runDir, d)]));
			const r = scanPaths({ roots: [...roots, path.join(HERE, '.svelte-kit')], canaries: [...canaries] });
			rmSync(path.join(runDir, 'summary-draft.json'));
			scanHits = r.hits.length;
			check(r.hits.length === 0, `no key, token, dev browser JWT, ticket or password of this run, and no credential shape, in ${r.files} files of logs, local state, the build and the summary${r.hits.length ? `; hits: ${r.hits.map((h) => `${path.relative(runDir, h.file)} (${h.rule})`).join(', ')}` : ''}`);
		});
	} catch (e) {
		failure ??= e instanceof Error ? e.message : String(e);
	}
	summary.legs = legs;
	summary.failure = failure;
	const draft = { ...summary, evidence: true };
	const problems = failure === null && clean && endSha === sha ? checkSummary(draft, { head: sha, digestAt: inputsDigest, isAncestor: () => true }) : ['not attempted'];
	summary.evidence = problems.length === 0;
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
	for (const name of LEGS) console.log(`${legs[name].status.padEnd(7)} ${name}${legs[name].failure ? `: ${legs[name].failure}` : ''}`);
	if (failure === null) for (const p of problems.slice(0, 10)) console.log(`refused: ${p}`);
	console.log(`clerk: users ${clerk.users.created}/${clerk.users.deleted} invitations ${clerk.invitations.created}/${clerk.invitations.deleted} sessions ${clerk.sessions.created}/${clerk.sessions.ended} (created/ended, ${clerk.sessions.pending} pending); scan hits ${scanHits}`);
	console.log(`${summary.evidence ? 'PROBE PASS' : 'PROBE FAIL'} ${sha} evidence: ${summary.evidence} summary: ${path.relative(root, out)}`);
	return summary.evidence ? 0 : 1;

	function bodyFor(r: Row, cls: Class): unknown {
		switch (r.route) {
			case '/cases/[case]/notes':
				return { requestId: `matrix-${cls}-${runId}`, body: 'synthetic matrix note' };
			case '/admin/invitations':
			case '/manage/firm-admin-invitations':
			case '/manage/staff-invitations':
				// short: the local part, with the run prefix and +clerk_test, must stay within the app's 64 characters
				return { email: emailOf(`mx-${{ '/admin/invitations': 'member', '/manage/firm-admin-invitations': 'firmadmin', '/manage/staff-invitations': 'operator' }[r.route]}-${cls}`) };
			case '/admin/assignments':
				return r.method === 'POST' ? { subject: person('viewer1').subject, case: 'case-1', role: 'viewer' } : { subject: 'user_not_enrolled', case: 'case-1' };
			case '/manage/operator-grants':
				return { subject: person('operator').subject, case: 'case-1', seconds: 600 };
			default:
				return {};
		}
	}
}

const { values } = parseArgs({ options: { out: { type: 'string' } } });
try {
	const root = git('rev-parse', '--show-toplevel');
	process.exitCode = await main(path.resolve(values.out ?? path.join(root, '.local/hosting-probe/identity/summary.json')));
} catch (e) {
	if (!(e instanceof Refusal)) throw e;
	console.error(`probe: refused: ${e.message}`);
	process.exitCode = 2;
}
