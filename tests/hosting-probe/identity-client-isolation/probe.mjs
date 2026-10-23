import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { takeSecrets } from '../../../deploy/probes/secrets-child.mjs';
import { Backend, Browser, Pace, claimsOf, frontendApi, ticketOf, halt } from '../identity/clerk.ts';
import { HERE, build, realNode, checkInstalled, freePorts, onInterrupt, run } from '../identity/harness.ts';
import { CLIENTS, INSTANCES, HOLD, LIFECYCLE, tokenSlot } from './transcript.mjs';
import { ROOT, SCHEMA, INPUTS, ENVIRONMENT, git, digest, pins } from './check.mjs';
import { world } from './world.mjs';
import { sweep } from './scenario.mjs';
import { cleanupRun } from './cleanup.mjs';
import { finishRun } from './report.mjs';

// Do not expose exception strings from SDK, build or child-process boundaries: they can carry secrets.
let stage = 'preflight';
try { await main(); } catch { console.error(`ISOLATION FAIL during ${stage}; live acceptance not established`); process.exitCode = 1; }

async function main() {
	if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 24) throw new Error('real Node >=24 required');
	const sha = git(['rev-parse', 'HEAD']);
	if (git(['status', '--porcelain'])) throw new Error('clean committed checkout required');
	const node = realNode();
	checkInstalled();
	const bun = process.env.PROBE_BUN;
	if (!bun || run(bun, ['--version']).out.trim() !== pins.packageManager.slice(4)) throw new Error('Bun pin mismatch');
	const keys = takeSecrets();
	const canaries = new Set();
	const secret = (s) => { if (typeof s !== 'string' || s.length < 12) throw new Error('missing credential'); canaries.add(s); return s; };
	const prefixes = { a: 'CLIENT_A', c: 'CLIENT_C', staff: 'STAFF' };
	const backends = {};
	const pace = new Pace(35, 10_000);
	for (const [name, prefix] of Object.entries(prefixes)) {
		const pk = secret(keys.get(`${prefix}_PK`));
		const sk = secret(keys.get(`${prefix}_SK`));
		if (!pk.startsWith('pk_test_') || !sk.startsWith('sk_test_') || frontendApi(pk) !== INSTANCES[name].issuer) throw new Error('unexpected development instance');
		backends[name] = new Backend(sk, pace);
	}
	const parent = path.join(ROOT, '.local/hosting-probe/identity-client-isolation');
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(path.join(parent, 'live-'));
	mkdirSync(path.join(dir, 'logs'));
	const prefix = `cc201-${randomBytes(10).toString('hex')}-`;
	writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sourceSha: sha, prefix, instances: INSTANCES, evidence: false }));
	const ports = await freePorts(4);
	const origins = { a: `http://127.0.0.1:${ports[0]}`, c: `http://127.0.0.1:${ports[2]}` };
	const staffOrigins = { a: `http://127.0.0.1:${ports[1]}`, c: `http://127.0.0.1:${ports[3]}` };
	const worlds = {};
	const people = {};
	const signedIn = {};
	const parties = { 'client-a': origins.a, 'client-c': origins.c, 'staff-a': staffOrigins.a, 'staff-c': staffOrigins.c };
	const owned = { users: [], invitations: [] };
	const sessions = [];
	const cleanup = { usersCreated: 0, usersDeleted: 0, invitationsCreated: 0, invitationsDeleted: 0, sessionsCreated: 0, sessionsEnded: 0, remaining: 0 };
	let interrupted = false;
	let finish;
	const finished = new Promise((resolve) => { finish = resolve; });
	const unregister = onInterrupt(async () => { interrupted = true; halt.on = true; await finished; });
	let data;
	let failure = false;
	let cleanupOkay = false;
	try {
		stage = 'build';
		const buildLog = build(node, dir, sha, bun);
		if (!buildLog.includes(`[probe build host] {"bun":"${pins.packageManager.slice(4)}"`)) throw new Error('build was not hosted by pinned Bun');
		stage = 'instance inspection';
		for (const inst of Object.values(INSTANCES)) {
			const res = await fetch(`${inst.issuer}/v1/environment`, { signal: AbortSignal.timeout(30_000) });
			const e = await res.json();
			const u = e.user_settings;
			if (!res.ok || e.display_config?.application_name !== inst.name || e.display_config?.instance_environment_type !== 'development' || u?.sign_up?.mode !== 'restricted' || u?.sign_up?.mfa?.required !== false || u?.sign_in?.second_factor?.required !== false || Object.values(u?.attributes ?? {}).some((a) => a.enabled && a.used_for_second_factor)) throw new Error('development configuration differs');
		}
		stage = 'synthetic sessions';
		for (const name of CLIENTS) {
			people[name] = await person(name, name, origins[name]);
			for (const [party, origin] of Object.entries(parties)) signedIn[`${name}@${party}`] = party === `client-${name}` ? people[name] : await otherParty(name, people[name], origin);
			people[`staff-${name}`] = await person('staff', `staff-${name}`, staffOrigins[name]);
			signedIn[`staff-${name}@staff-${name}`] = people[`staff-${name}`];
		}
		stage = 'local workers';
		for (const [i, name] of CLIENTS.entries()) {
			const selected = new Map([['CLIENT_A_PK', keys.get(`${prefixes[name]}_PK`)], ['CLIENT_A_SK', keys.get(`${prefixes[name]}_SK`)], ['STAFF_PK', keys.get('STAFF_PK')], ['STAFF_SK', keys.get('STAFF_SK')]]);
			const w = await world({ node, dir: path.join(dir, name), ports: ports.slice(i * 2, i * 2 + 2), keys: selected, clientSubject: people[name].subject, staffSubject: people[`staff-${name}`].subject, sha });
			worlds[name] = w;
			for (const [key, expected] of Object.entries(ENVIRONMENT)) if (key.startsWith('WRANGLER_') || key.startsWith('CLOUDFLARE_')) {
				if (w.env[key] !== expected) throw new Error('local runtime environment differs');
			}
			if (w.config.jwtKeys || w.config.apiUrl || w.config.mfaRequired || worlds.a?.config.persist === worlds.c?.config.persist) throw new Error('invalid local topology');
			w.token = async (actor, staff) => {
				const slot = tokenSlot(name, actor, staff);
				const p = signedIn[`${slot.person}@${slot.party}`];
				await pace.take();
				const token = secret(await p.browser.token(p.session));
				const claims = claimsOf(token);
				if (claims.iss !== INSTANCES[p.instance].issuer || claims.azp !== parties[slot.party] || claims.azp !== p.browser.origin || claims.sub !== p.subject || claims.sid !== p.session || claims.exp <= Date.now() / 1000) throw new Error('unexpected session claims');
				return token;
			};
		}
		stage = 'reciprocal request sweep';
		data = await sweep(worlds);
	} catch { failure = true; }
	finally {
		// A signal only halts creation; cleanup starts after the in-flight operation settles.
		halt.on = true;
		cleanupOkay = await cleanupRun({ backends, prefix, sessions, owned, worlds, counts: cleanup });
	}
	// Failed and interrupted runs take the same scan path; the signal hook waits through it.
	try {
		const summary = { schema: SCHEMA, sourceSha: sha, inputs: { paths: INPUTS, digest: digest(sha) }, treeClean: git(['rev-parse', 'HEAD']) === sha && !git(['status', '--porcelain']),
			mode: 'live-clerk-development', runDir: path.relative(ROOT, dir).split(path.sep).join('/'), environment: ENVIRONMENT, instances: INSTANCES, served: { a: sha, c: sha }, ...data,
			lifecycle: LIFECYCLE.map((assertion) => ({ assertion, pass: !failure && !interrupted && cleanupOkay })), cleanup, scan: { files: 0, hits: 0, manifest: [] }, hold: HOLD, evidence: false };
		finishRun({ summary, dir, buildDir: path.join(HERE, '.svelte-kit'), canaries: [...canaries], failure: { failed: failure, interrupted, cleanupOkay, stage } });
		console.log(`ISOLATION ${summary.evidence ? 'PASS' : 'FAIL'} ${sha}; summary ${path.relative(ROOT, dir)}/summary.json`);
		if (!summary.evidence) process.exitCode = 1;
	} finally { finish(); unregister(); }

	async function browser(instance, origin) {
		const testing = secret(await backends[instance].testingToken());
		const b = await Browser.open(INSTANCES[instance].issuer, origin, testing);
		secret(b.devBrowser);
		return b;
	}
	async function person(instance, name, origin) {
		const email = `${prefix}${name}+clerk_test@example.com`;
		const password = secret(`Cc201!${randomBytes(24).toString('hex')}`);
		const inv = await backends[instance].createInvitation(email, origin + '/invite/accept');
		owned.invitations.push({ instance, id: inv.id });
		cleanup.invitationsCreated++;
		const b = await browser(instance, origin);
		const session = await b.signUpWithTicket(secret(ticketOf(inv.url)), password);
		cleanup.usersCreated++; cleanup.sessionsCreated++;
		sessions.push({ instance, id: session });
		const token = secret(await b.token(session));
		const subject = claimsOf(token).sub;
		owned.users.push({ instance, id: subject });
		return { instance, subject, email, session, browser: b };
	}
	async function otherParty(instance, p, origin) {
		const b = await browser(instance, origin);
		const session = await b.signInWithEmailCode(p.email);
		cleanup.sessionsCreated++; sessions.push({ instance, id: session });
		return { ...p, session, browser: b };
	}
}
