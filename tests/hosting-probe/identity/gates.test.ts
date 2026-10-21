// The probe's gates on native workerd against crafted issuers (crafted.ts): the hook, claim checks, D1 grants, R2
// assets and audit are the probe's real code; only the token issuer and Clerk's session-status endpoint stand in.
// These cover what a real Clerk instance will not issue: tokens missing a claim, with the wrong algorithm or issuer,
// signed by another key, and a status endpoint that fails. probe.ts covers the same gates against Clerk itself.
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CLIENT_ORIGIN, craftedWorld, STAFF_ORIGIN, type World } from './crafted.ts';

let w: World;
// the root vitest.config.ts has a 10 s hook timeout and a 60 s test timeout; a world is a build, a seed and two workerds
beforeAll(async () => {
	w = await craftedWorld();
}, 180_000);
afterAll(async () => {
	await w?.stop();
});

const json = { accept: 'application/json' };
const markers = (body: string) => body.match(/CC108-CASE\d-[A-Z]+/g) ?? [];

describe('wrong case and logged out', () => {
	test("a case-1 viewer reading case 2's metadata gets 404 and none of case 2's bytes", async () => {
		const res = await w.get(CLIENT_ORIGIN, '/cases/case-2', { token: w.token(w.client, 'user_crafted_viewer1'), headers: { accept: 'application/json' } });
		expect(res.status).toBe(404);
		expect(res.denial).toBe('no-case-access');
		expect(res.body).not.toContain('CC108-CASE2');
	});

	test("a logged-out request for case 1's metadata gets 401 and none of case 1's bytes", async () => {
		const res = await w.get(CLIENT_ORIGIN, '/cases/case-1', { headers: { accept: 'application/json' } });
		expect(res.status).toBe(401);
		expect(res.denial).toBe('signed-out');
		expect(res.body).not.toContain('CC108-CASE1');
	});

	test("case 2's document, user work, published and draft assets, and a Note on case 2, are refused to a case-1 viewer", async () => {
		const t = w.token(w.client, 'user_crafted_viewer1');
		for (const p of ['/cases/case-2/documents/doc-2', '/cases/case-2/notes', '/cases/case-2/assets/summary.txt', '/cases/case-1/documents/doc-2', '/cases/case-1/assets/candidate.txt']) {
			const res = await w.get(CLIENT_ORIGIN, p, { token: t, headers: { ...json, range: 'bytes=0-9', 'if-none-match': '*' } });
			expect([p, res.status]).toEqual([p, 404]);
			expect(markers(res.body)).toEqual([]);
		}
		const post = await w.get(CLIENT_ORIGIN, '/cases/case-2/notes', { token: t, method: 'POST', headers: { ...json, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'crafted-wrong-case', body: 'x' }) });
		expect([post.status, post.denial]).toEqual([404, 'no-case-access']);
	});

	test('a viewer cannot write (403 editor-required); an editor can, once per request id', async () => {
		const note = (sub: string) => w.get(CLIENT_ORIGIN, '/cases/case-1/notes', { token: w.token(w.client, sub), method: 'POST', headers: { ...json, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'crafted-note-0001', body: 'synthetic' }) });
		expect((await note('user_crafted_viewer1')).denial).toBe('editor-required');
		expect((await note('user_crafted_editor1')).status).toBe(201);
		expect((await note('user_crafted_editor1')).status).toBe(200);
	});

	test('a firm admin and an unassigned member see no case; a non-member is refused', async () => {
		expect((await w.get(CLIENT_ORIGIN, '/cases/case-1', { token: w.token(w.client, 'user_crafted_firmadmin'), headers: json })).status).toBe(404);
		const list = await w.get(CLIENT_ORIGIN, '/cases', { token: w.token(w.client, 'user_crafted_firmadmin'), headers: json });
		expect([list.status, markers(list.body)]).toEqual([200, []]);
		expect((await w.get(CLIENT_ORIGIN, '/cases', { token: w.token(w.client, 'user_crafted_stranger'), headers: json })).denial).toBe('not-a-member');
		expect((await w.get(CLIENT_ORIGIN, '/admin/members', { token: w.token(w.client, 'user_crafted_stranger'), headers: json })).denial).toBe('not-a-member');
		expect((await w.get(CLIENT_ORIGIN, '/admin/members', { token: w.token(w.client, 'user_crafted_viewer1'), headers: json })).denial).toBe('firm-admin-required');
		const own = await w.get(CLIENT_ORIGIN, '/cases', { token: w.token(w.client, 'user_crafted_viewer2'), headers: json });
		expect([own.status, [...new Set(markers(own.body))]]).toEqual([200, ['CC108-CASE2-META']]);
	});
});

describe('claims, keys and algorithms (fail closed on a missing or wrong claim)', () => {
	const cases: [string, (t: World) => string, string][] = [
		['no sub', (t) => t.token(t.client, 'user_crafted_viewer1', { sub: undefined }), 'token-invalid'],
		['an empty sub', (t) => t.token(t.client, 'user_crafted_viewer1', { sub: '' }), 'claim-missing'],
		['no sid', (t) => t.token(t.client, 'user_crafted_viewer1', { sid: undefined }), 'claim-missing'],
		['a numeric sid', (t) => t.token(t.client, 'user_crafted_viewer1', { sid: 7 }), 'claim-missing'],
		['no azp', (t) => t.token(t.client, 'user_crafted_viewer1', { azp: undefined }), 'wrong-party'],
		["the staff app's azp", (t) => t.token(t.client, 'user_crafted_viewer1', {}, STAFF_ORIGIN), 'wrong-party'],
		['an issuer the key does not belong to', (t) => t.token(t.client, 'user_crafted_viewer1', { iss: 'https://crafted-other.clerk.invalid' }), 'wrong-issuer'],
		['no iss', (t) => t.token(t.client, 'user_crafted_viewer1', { iss: undefined }), 'wrong-issuer'],
		['exp in the past (beyond the 5 s skew)', (t) => t.token(t.client, 'user_crafted_viewer1', { exp: Math.floor(Date.now() / 1000) - 30, iat: Math.floor(Date.now() / 1000) - 90 }), 'token-expired'],
		['no exp', (t) => t.token(t.client, 'user_crafted_viewer1', { exp: undefined }), 'token-invalid'],
		['nbf in the future', (t) => t.token(t.client, 'user_crafted_viewer1', { nbf: Math.floor(Date.now() / 1000) + 600 }), 'token-invalid'],
		['a pending session (sts)', (t) => t.token(t.client, 'user_crafted_viewer1', { sts: 'pending' }), 'session-pending'],
		["the staff instance's token", (t) => t.token(t.staff, 'user_crafted_ga', {}, CLIENT_ORIGIN), 'token-invalid'],
		['a signature from another key', (t) => t.client.sign({ ...JSON.parse(Buffer.from(t.token(t.client, 'user_crafted_viewer1').split('.')[1]!, 'base64url').toString()) }, {}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), 'token-invalid'],
		['alg none', (t) => `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: t.client.kid })).toString('base64url')}.${t.token(t.client, 'user_crafted_viewer1').split('.')[1]}.`, 'token-invalid'],
		['a changed payload under the old signature', (t) => { const [h, , sig] = t.token(t.client, 'user_crafted_viewer1').split('.'); return `${h}.${Buffer.from(JSON.stringify({ sub: 'user_crafted_editor1', sid: 'sess_user_crafted_editor1', iss: t.client.iss, azp: CLIENT_ORIGIN, exp: Math.floor(Date.now() / 1000) + 60, iat: Math.floor(Date.now() / 1000), nbf: Math.floor(Date.now() / 1000) - 5, v: 2 })).toString('base64url')}.${sig}`; }, 'token-invalid'],
	];
	for (const [what, make, reason] of cases) {
		test(`a token with ${what} is refused (401 ${reason}) with none of case 1's bytes`, async () => {
			const res = await w.get(CLIENT_ORIGIN, '/cases/case-1', { token: make(w), headers: json });
			expect([res.status, res.denial]).toEqual([401, reason]);
			expect(markers(res.body)).toEqual([]);
		});
	}

	test('a Bearer token and a different __session cookie together are refused (credential-ambiguous)', async () => {
		const res = await w.get(CLIENT_ORIGIN, '/cases/case-1', { token: w.token(w.client, 'user_crafted_viewer1'), cookies: { __session: w.token(w.client, 'user_crafted_editor1') }, headers: json });
		expect([res.status, res.denial]).toEqual([401, 'credential-ambiguous']);
	});

	test('a malformed Authorization header is refused (credential-malformed)', async () => {
		const res = await w.get(CLIENT_ORIGIN, '/cases/case-1', { headers: { ...json, authorization: 'Basic dXNlcjpwYXNz' } });
		expect([res.status, res.denial]).toEqual([401, 'credential-malformed']);
	});
});

describe('current session status', () => {
	test('a revoked, ended or reassigned session is refused while its token is unexpired', async () => {
		for (const [status, reason] of [['revoked', 'session-revoked'], ['ended', 'session-ended'], ['expired', 'session-ended']] as const) {
			const t = w.token(w.client, 'user_crafted_viewer1');
			w.status.set('sess_user_crafted_viewer1', 'user_crafted_viewer1', status);
			const res = await w.get(CLIENT_ORIGIN, '/cases/case-1', { token: t, headers: json });
			expect([status, res.status, res.denial]).toEqual([status, 401, reason]);
		}
		const t = w.token(w.client, 'user_crafted_viewer1');
		w.status.set('sess_user_crafted_viewer1', 'user_crafted_editor1');
		expect((await w.get(CLIENT_ORIGIN, '/cases/case-1', { token: t, headers: json })).denial).toBe('session-mismatch');
	});

	test('a status lookup that fails is 503 and releases nothing (fail closed)', async () => {
		const t = w.token(w.client, 'user_crafted_viewer1');
		w.status.outage(true);
		try {
			for (const p of ['/cases/case-1', '/cases/case-1/documents/doc-1', '/cases/case-1/assets/summary.txt']) {
				const res = await w.get(CLIENT_ORIGIN, p, { token: t, headers: json });
				expect([p, res.status, res.denial]).toEqual([p, 503, 'session-status-unavailable']);
				expect(markers(res.body)).toEqual([]);
			}
		} finally {
			w.status.outage(false);
		}
		expect((await w.get(CLIENT_ORIGIN, '/cases/case-1', { token: w.token(w.client, 'user_crafted_viewer1'), headers: { accept: 'text/html' } })).body).toContain('CC108-CASE1-META');
	});
});

describe('staff and client separation, operator grants and audit', () => {
	test("a client session is refused on the client app's staff routes, and a staff session on its case routes", async () => {
		const client = w.token(w.client, 'user_crafted_viewer1', {}, STAFF_ORIGIN);
		expect((await w.get(CLIENT_ORIGIN, '/operator/cases/case-1', { token: client, headers: json })).status).toBe(401);
		expect((await w.get(CLIENT_ORIGIN, '/manage/audit', { token: client, headers: json })).status).toBe(401);
		const staff = w.token(w.staff, 'user_crafted_ga');
		expect((await w.get(CLIENT_ORIGIN, '/cases', { token: staff, headers: json })).status).toBe(401);
		expect((await w.get(STAFF_ORIGIN, '/cases/case-1', { token: staff, headers: json })).denial).toBe('not-served');
	});

	test('the Global Admin reads no case without a grant; a grant opens one case to one operator, and every decision is audited', async () => {
		const ga = () => w.token(w.staff, 'user_crafted_ga');
		const op = () => w.token(w.staff, 'user_crafted_operator');
		expect((await w.get(CLIENT_ORIGIN, '/operator/cases/case-1', { token: ga(), headers: json })).denial).toBe('no-operator-grant');
		expect((await w.get(CLIENT_ORIGIN, '/operator/cases/case-1/drafts/candidate.txt', { token: op(), headers: json })).denial).toBe('no-operator-grant');
		const grant = await w.get(CLIENT_ORIGIN, '/manage/operator-grants', { token: ga(), method: 'POST', headers: { ...json, 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user_crafted_operator', case: 'case-1', seconds: 600 }) });
		expect(grant.status).toBe(201);
		const draft = await w.get(CLIENT_ORIGIN, '/operator/cases/case-1/drafts/candidate.txt', { token: op(), headers: json });
		expect([draft.status, markers(draft.body)]).toEqual([200, ['CC108-CASE1-DRAFT']]);
		expect((await w.get(CLIENT_ORIGIN, '/operator/cases/case-2', { token: op(), headers: json })).denial).toBe('no-operator-grant');
		const byOperator = await w.get(CLIENT_ORIGIN, '/manage/operator-grants', { token: op(), method: 'POST', headers: { ...json, 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user_crafted_operator', case: 'case-2', seconds: 600 }) });
		expect(byOperator.denial).toBe('instance-admin-required');
		const audit = JSON.parse((await w.get(CLIENT_ORIGIN, '/manage/audit', { token: ga(), headers: json })).body) as { events: { subject: string | null; action: string; case_id: string | null; outcome: string }[] };
		const has = (subject: string, action: string, caseId: string | null, outcome: string) => audit.events.some((e) => e.subject === subject && e.action === action && e.case_id === caseId && e.outcome === outcome);
		expect(has('user_crafted_operator', 'GET /operator/cases/[case]/drafts/[...name]', 'case-1', 'allowed')).toBe(true);
		expect(has('user_crafted_operator', 'GET /operator/cases/[case]/drafts/[...name]', 'case-1', 'denied:no-operator-grant')).toBe(true);
		expect(has('user_crafted_ga', 'GET /operator/cases/[case]', 'case-1', 'denied:no-operator-grant')).toBe(true);
		expect(has('user_crafted_ga', 'POST /manage/operator-grants', 'case-1', 'grant:user_crafted_operator')).toBe(true);
		expect(has('user_crafted_viewer1', 'GET /cases/[case]', 'case-2', 'denied:no-case-access')).toBe(true);
		expect(audit.events.some((e) => e.subject === null && e.outcome === 'denied:signed-out')).toBe(true);
		expect(markers(JSON.stringify(audit))).toEqual([]);
	});

	test('a grant to a subject that is not a user of the staff instance is refused, audited and opens nothing', async () => {
		const ga = () => w.token(w.staff, 'user_crafted_ga');
		const stranger = 'user_crafted_unenrolled';
		const grant = await w.get(CLIENT_ORIGIN, '/manage/operator-grants', { token: ga(), method: 'POST', headers: { ...json, 'content-type': 'application/json' }, body: JSON.stringify({ subject: stranger, case: 'case-1', seconds: 600 }) });
		expect(grant.status).toBe(404);
		const read = await w.get(CLIENT_ORIGIN, '/operator/cases/case-1/drafts/candidate.txt', { token: w.token(w.staff, stranger), headers: json });
		expect([read.status, read.denial, markers(read.body)]).toEqual([403, 'no-operator-grant', []]);
		const audit = JSON.parse((await w.get(CLIENT_ORIGIN, '/manage/audit', { token: ga(), headers: json })).body) as { events: { subject: string | null; case_id: string | null; outcome: string }[] };
		expect(audit.events.some((e) => e.subject === 'user_crafted_ga' && e.case_id === 'case-1' && e.outcome === 'denied:unknown-grantee')).toBe(true);
		expect(audit.events.some((e) => e.outcome === `grant:${stranger}`)).toBe(false);
	});

	test("a firm admin's own assignment is explicit: it opens the case, its removal closes it, and both are audited by case", async () => {
		const fa = () => w.token(w.client, 'user_crafted_firmadmin');
		const change = (method: string, body: object) => w.get(CLIENT_ORIGIN, '/admin/assignments', { token: fa(), method, headers: { ...json, 'content-type': 'application/json' }, body: JSON.stringify(body) });
		expect((await change('POST', { subject: 'user_crafted_firmadmin', case: 'case-1', role: 'viewer' })).status).toBe(201);
		const read = await w.get(CLIENT_ORIGIN, '/cases/case-1/documents/doc-1', { token: fa(), headers: json });
		expect(read.status).toBe(200);
		expect(markers(read.body)).toContain('CC108-CASE1-TEXT');
		expect(markers(read.body).filter((m) => !m.startsWith('CC108-CASE1'))).toEqual([]);
		expect(JSON.parse((await change('DELETE', { subject: 'user_crafted_firmadmin', case: 'case-1' })).body).removed).toBe(1);
		expect((await w.get(CLIENT_ORIGIN, '/cases/case-1/documents/doc-1', { token: fa(), headers: json })).denial).toBe('no-case-access');
		const events = (JSON.parse((await w.get(CLIENT_ORIGIN, '/manage/audit', { token: w.token(w.staff, 'user_crafted_ga'), headers: json })).body) as { events: { subject: string; case_id: string | null; outcome: string }[] }).events;
		const mine = events.filter((e) => e.subject === 'user_crafted_firmadmin' && e.case_id === 'case-1').map((e) => e.outcome);
		expect(mine).toEqual(expect.arrayContaining(['assign:user_crafted_firmadmin:viewer', 'unassign:user_crafted_firmadmin', 'allowed', 'denied:no-case-access']));
	});

	test('when the audit cannot be written, an authorized read is refused (503) with no bytes, and nothing is granted', async () => {
		w.execute('client', 'ALTER TABLE audit RENAME TO audit_offline');
		try {
			const read = await w.get(CLIENT_ORIGIN, '/cases/case-1/assets/summary.txt', { token: w.token(w.client, 'user_crafted_viewer1'), headers: json });
			expect([read.status, read.denial, markers(read.body)]).toEqual([503, 'access-unavailable', []]);
			const grant = await w.get(CLIENT_ORIGIN, '/manage/operator-grants', { token: w.token(w.staff, 'user_crafted_ga'), method: 'POST', headers: { ...json, 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user_crafted_operator', case: 'case-2', seconds: 600 }) });
			expect(grant.status).toBe(503);
		} finally {
			w.execute('client', 'ALTER TABLE audit_offline RENAME TO audit');
		}
		expect((await w.get(CLIENT_ORIGIN, '/operator/cases/case-2', { token: w.token(w.staff, 'user_crafted_operator'), headers: json })).denial).toBe('no-operator-grant');
	});

	test('a route an app does not serve answers 404, and a method a route does not take 405, before any identity call', async () => {
		const before = w.status.calls.length;
		expect((await w.get(CLIENT_ORIGIN, '/manage/staff', { token: w.token(w.staff, 'user_crafted_ga'), headers: json })).denial).toBe('not-served');
		expect((await w.get(CLIENT_ORIGIN, '/cases/case-1/documents/doc-1', { method: 'DELETE', headers: json })).status).toBe(405);
		expect(w.status.calls.length).toBe(before);
	});
});

describe('invitations', () => {
	test('an invitation enrols the one user whose verified email it names, once; an expired one enrols nobody', async () => {
		const accept = (sub: string) => w.get(CLIENT_ORIGIN, '/invite/accept', { token: w.token(w.client, sub), method: 'POST', headers: { ...json, 'content-type': 'application/json' }, body: '{}' });
		w.status.user('user_crafted_invitee', 'crafted-invitee@example.com');
		w.status.user('user_crafted_second', 'crafted-invitee@example.com');
		w.status.user('user_crafted_late', 'crafted-expired@example.com');
		const first = await accept('user_crafted_invitee');
		expect([first.status, JSON.parse(first.body).role]).toEqual([201, 'member']);
		expect((await accept('user_crafted_invitee')).denial).toBe('already-a-member');
		expect((await accept('user_crafted_second')).denial).toBe('no-invitation');
		expect((await accept('user_crafted_late')).denial).toBe('no-invitation');
		expect((await w.get(CLIENT_ORIGIN, '/cases', { token: w.token(w.client, 'user_crafted_invitee'), headers: json })).body).not.toMatch(/CC108/);
	});
});

describe('MFA flag', () => {
	test('off by default: a token with no second factor (fva [0, -1]) is accepted', async () => {
		const res = await w.get(CLIENT_ORIGIN, '/auth/session', { token: w.token(w.client, 'user_crafted_viewer1'), headers: json });
		expect([res.status, JSON.parse(res.body).mfaRequired]).toEqual([200, false]);
	});

	test('on: the server refuses a token without a verified second factor, whatever the UI shows', async () => {
		const m = await craftedWorld({ mfaRequired: true, ports: [18833, 18834] });
		try {
			const origin = 'http://127.0.0.1:18833';
			const no = await m.get(origin, '/cases/case-1', { token: m.token(m.client, 'user_crafted_viewer1', {}, origin), headers: json });
			expect([no.status, no.denial]).toEqual([401, 'mfa-required']);
			const yes = await m.get(origin, '/cases/case-1', { token: m.token(m.client, 'user_crafted_viewer1', { fva: [0, 0] }, origin), headers: { accept: 'text/html' } });
			expect(yes.status).toBe(200);
		} finally {
			await m.stop();
		}
	}, 180_000);
});

describe('default deny in the hook', () => {
	test("a remote-function request (/_app/remote/...) never reaches Kit's handler: 404 not-served, signed in or not, whatever the method", async () => {
		const viewer = w.token(w.client, 'user_crafted_viewer1');
		for (const p of ['/_app/remote/abc123/readCase', '/_app/remote/abc123/writeNote?payload=e30']) {
			for (const [who, token] of [['anonymous', undefined], ['viewer', viewer]] as const) {
				for (const method of ['GET', 'POST']) {
					const res = await w.get(CLIENT_ORIGIN, p, { token, method, headers: json });
					expect([who, method, p, res.status, res.denial]).toEqual([who, method, p, 404, 'not-served']);
				}
			}
		}
		expect((await w.get(STAFF_ORIGIN, '/_app/remote/abc123/readCase', { headers: json })).denial).toBe('not-served');
	});

	test("a path that no route matches still gets Kit's own 404, with no identity call", async () => {
		const before = w.status.calls.length;
		const res = await w.get(CLIENT_ORIGIN, '/no-such-page', { token: w.token(w.client, 'user_crafted_viewer1'), headers: { accept: 'text/html' } });
		expect([res.status, res.denial]).toEqual([404, null]);
		expect(w.status.calls.length).toBe(before + 0);
	});
});

// M1: serve.mjs runs in a process group of its own, so nothing stops it with its runner unless the runner arranges it.
// lifecycle-child.ts starts a crafted world and ends the ways a runner ends; each test then asks whether the two ports
// are still held. CRAFTED_SKIP_BUILD lets the children reuse this file's build (the tests run one after another).
describe('process lifecycle: serve.mjs and its workerd stop with the runner that started them', () => {
	// the shared world is stopped first: at 3a0b1a95 every world takes the same two ports
	beforeAll(async () => {
		await w.stop();
	}, 60_000);
	const listening = (port: number) => new Promise<boolean>((resolve) => {
		const s = connect(port, '127.0.0.1');
		s.once('connect', () => (s.destroy(), resolve(true)));
		s.once('error', () => resolve(false));
	});
	/** The serve.mjs processes (each a group leader) started for these ports, or by this runner: its argv carries the config JSON. */
	const serveLeaders = (ports: number[], runner: number) => readdirSync('/proc').filter((n) => /^\d+$/.test(n)).flatMap((n) => {
		try {
			const argv = readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0');
			if (!argv.some((a) => a.endsWith('serve.mjs'))) return [];
			const stat = readFileSync(`/proc/${n}/stat`, 'utf8');
			const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
			return parent === runner || ports.some((p) => argv.some((a) => a.includes(`"port":${p}`))) ? [Number(n)] : [];
		} catch {
			return [];
		}
	});
	for (const mode of ['exit', 'throw', 'SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
		test(`on ${mode} of the runner`, async () => {
			const child = spawn(process.execPath, [path.join(import.meta.dirname, 'lifecycle-child.ts'), mode], { cwd: import.meta.dirname, env: { ...process.env, CRAFTED_SKIP_BUILD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
			const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
			let ports: number[] = [];
			try {
				let text = '';
				ports = await new Promise<number[]>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`the runner printed no world within 150 s: ${text.slice(-800)}`)), 150_000);
					const onData = (b: Buffer) => {
						text += b.toString();
						const m = /^world (\{.*\})$/m.exec(text);
						if (m) (clearTimeout(timer), resolve((JSON.parse(m[1]!) as { ports: number[] }).ports));
					};
					child.stdout!.on('data', onData);
					child.stderr!.on('data', onData);
					child.once('exit', () => (clearTimeout(timer), reject(new Error(`the runner ended before it printed a world: ${text.slice(-800)}`))));
				});
				if (mode.startsWith('SIG')) {
					expect(await Promise.all(ports.map(listening))).toEqual([true, true]);
					child.kill(mode);
				}
				await exited;
				let held = ports;
				for (const until = Date.now() + 20_000; Date.now() < until && held.length; ) {
					const open = await Promise.all(ports.map(listening));
					held = ports.filter((_, i) => open[i]);
					if (held.length) await new Promise((r) => setTimeout(r, 250));
				}
				expect(held, `ports still held 20 s after the runner ended on ${mode}`).toEqual([]);
			} finally {
				for (const pid of serveLeaders(ports, child.pid!)) try { process.kill(-pid, 'SIGKILL'); } catch {}
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			}
		}, 240_000);
	}
});
