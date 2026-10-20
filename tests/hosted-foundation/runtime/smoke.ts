// The request, render and action smoke test of the running hosted artifact (GRS-112). `bun run --bun test:hosted` runs
// it against the server `start:hosted` serves on workerd; it is not a Vitest file, because only that workerd run is
// hosted evidence. The hosted-gate legs walk GRS-138's feature map: sign in as a test identity, open the provisioned
// case, open an original, and see a wrong-client and a wrong-case request denied and audited.
import { createHash } from 'node:crypto';
import type { HostedProfile } from '../../../scripts/ci/hosted-imports.ts';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';
import { gateFixture } from './gate-fixture.ts';

export type Leg = { name: string; status: 'PASS' | 'FAIL'; asserted: string[]; failure?: string };
type Answer = { status: number; headers: Headers; body: Uint8Array; text: string };

export async function smoke(a: { base: string; profile: HostedProfile; revision: string; root: string; query: (sql: string) => Record<string, unknown>[] }): Promise<Leg[]> {
	const legs: Leg[] = [];
	async function leg(name: string, body: (check: (ok: boolean, what: string) => void) => Promise<void>) {
		const l: Leg = { name, status: 'FAIL', asserted: [] };
		legs.push(l);
		try {
			await body((ok, what) => {
				if (!ok) throw new Error(`assertion failed: ${what}`);
				l.asserted.push(what);
			});
			l.status = 'PASS';
		} catch (e) {
			l.failure = e instanceof Error ? e.message : String(e);
		}
	}
	async function http(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Answer> {
		const headers = new Headers(init.headers);
		if (init.cookie) headers.set('cookie', init.cookie);
		const res = await fetch(a.base + path, { redirect: 'manual', ...init, headers, signal: AbortSignal.timeout(15_000) });
		const body = new Uint8Array(await res.arrayBuffer());
		return { status: res.status, headers: res.headers, body, text: new TextDecoder().decode(body) };
	}
	const form = (path: string, fields: Record<string, string>, opts: { origin?: string; cookie?: string } = {}) =>
		http(path, { method: 'POST', cookie: opts.cookie, headers: { accept: 'text/html', origin: opts.origin ?? a.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
	const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

	await leg('request', async (check) => {
		const health = await http('/health');
		const h = JSON.parse(health.text) as { ok: boolean; runtime: string; build: { revision: string; profile: string } | null; gate: { fixtureSha256: string } | null; probe: { probes: { d1: boolean; r2: boolean } } | null; identityProvider: string | null };
		check(health.status === 200 && h.ok, 'GET /health is 200 and ok');
		check(h.runtime === 'Cloudflare-Workers', `the request ran on workerd (navigator.userAgent ${h.runtime})`);
		check(h.build?.revision === a.revision && h.build.profile === a.profile, `the served build is stamped ${a.revision} (${a.profile})`);
		check(h.probe?.probes.d1 === true && h.probe.probes.r2 === true, 'the D1 sentinel row and the R2 sentinel object round-trip through the Worker');
		if (a.profile === 'hosted-gate') check(h.gate?.fixtureSha256 === gateFixture().sha256 && h.identityProvider === 'test-identity-double', 'the hosted-gate artifact serves the provisioned synthetic fixture through the test identity double');
		else check(h.gate === null && h.identityProvider === null, 'the production artifact has no gate run and no test identity');
		const browse = await http('/api/browse?path=/');
		check(browse.status === 404 && !browse.text.includes('"entries"'), 'GET /api/browse?path=/ is 404: the local folder browser is not in the hosted graph');
		const worker = await http('/_worker.js');
		check(worker.status !== 200 && !worker.text.includes('export'), `the Worker source is not served as an asset (${worker.status})`);
		const unknown = await http('/v/1/documents');
		check(unknown.status === 503 && unknown.headers.get('retry-after') === '2', 'an unmigrated local route answers a typed 503 with retry-after');
		check(unknown.headers.get('cache-control') === 'no-store' && unknown.headers.get('x-content-type-options') === 'nosniff', 'security headers on every answer');
		const cross = await form('/sign-in', { identity: 'client-a/a-viewer' }, { origin: 'https://attacker.example.invalid' });
		check(cross.status === 403, 'a cross-origin form POST is refused 403 before any route runs');
	});

	if (a.profile === 'production') {
		await leg('production-refusals', async (check) => {
			for (const path of ['/', '/sign-in', '/cases', '/cases/case-a1', '/cases/case-a1/originals/a1-letter']) {
				const r = await http(path);
				check(r.status === 503 && r.text.startsWith('ClearCase is unavailable'), `GET ${path} is refused 503 until a hosted adapter lands`);
			}
			const scan = scanArtifact({ root: a.root, profile: 'production' });
			check(scan.errors.length === 0, `the served production artifact holds no test double and no local-only import (${scan.files} emitted modules)`);
		});
		return legs;
	}

	const fixture = gateFixture(), letter = fixture.originals.find((o) => o.asset_id === 'a1-letter')!;
	let viewer = '';
	await leg('render', async (check) => {
		const page = await http('/sign-in');
		check(page.status === 200 && page.text.includes('data-auth-provider="double"') && page.text.includes('id="test-identity"') && page.text.includes('id="sign-in"'), 'GET /sign-in renders the test identity form on workerd');
		const csp = page.headers.get('content-security-policy') ?? '';
		check(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"), 'the rendered page carries the app CSP');
		const anonymous = await http('/cases');
		check(anonymous.status === 401 && anonymous.text.includes('data-denial-code="unauthenticated"') && anonymous.text.includes('id="sign-in-link"'), 'GET /cases without a session renders 401 with a sign-in link');
	});

	await leg('action', async (check) => {
		const bad = await form('/sign-in', { identity: 'client-a/nobody' });
		check(bad.status === 400 && !bad.headers.get('set-cookie'), 'signing in as an unknown identity fails 400 and sets no cookie');
		const signIn = await form('/sign-in', { identity: 'client-a/a-viewer' });
		const cookie = signIn.headers.get('set-cookie') ?? '';
		check(signIn.status === 303 && signIn.headers.get('location') === '/cases', 'the sign-in action redirects 303 to /cases');
		check(/^clearcase_session=[0-9a-f-]{36};/.test(cookie) && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie), 'the session cookie is HttpOnly and SameSite=Lax');
		viewer = cookie.split(';')[0]!;
	});

	await leg('feature-map', async (check) => {
		const cases = await http('/cases', { cookie: viewer });
		check(cases.status === 200 && cases.text.includes('data-auth-state="signed-in"') && cases.text.includes('data-case-id="case-a1"') && cases.text.includes('data-action="open-case"'), 'the viewer sees case A1 on /cases');
		check(!cases.text.includes('case-a2') && !cases.text.includes('case-b1'), 'the list holds no case without a grant and no other client\'s case');
		const shell = await http('/cases/case-a1', { cookie: viewer });
		check(shell.status === 200 && shell.text.includes('data-results-state="pending"') && shell.text.includes('Results are not published yet'), 'case A1 opens through its stable identity with no publication: ResultsState shows pending');
		check(shell.text.includes('data-action="open-original"') && shell.text.includes('data-asset-id="a1-letter"') && shell.text.includes('data-user-work-state="unavailable"'), 'the shell lists the originals and shows user work apart from results');
		const original = await http('/cases/case-a1/originals/a1-letter', { cookie: viewer });
		check(original.status === 200 && sha(original.body) === letter.sha256 && original.body.length === letter.size, 'the original A1 letter arrives whole and matches its recorded SHA-256');
		check(original.headers.get('content-type')?.startsWith('application/pdf') === true && original.headers.get('content-disposition')?.startsWith('attachment;') === true, 'the original is served as an attachment with its media type');
		const ranged = await http('/cases/case-a1/originals/a1-letter', { cookie: viewer, headers: { range: 'bytes=0-63' } });
		check(ranged.status === 416 && ranged.body.length === 0, 'a Range request is refused 416 with no bytes');
		const head = await http('/cases/case-a1/originals/a1-letter', { cookie: viewer, method: 'HEAD' });
		check(head.status === 200 && head.body.length === 0, 'HEAD answers 200 without a body');
	});

	await leg('denials', async (check) => {
		for (const path of ['/cases/case-a2', '/cases/case-a2/originals/a2-statement', '/cases/case-b1', '/cases/case-a1/originals/b1-letter']) {
			const r = await http(path, { cookie: viewer });
			check(r.status === 404 && !r.text.includes('Synthetic original') && !r.text.includes('Synthetic matter A2') && !r.text.includes('Synthetic matter B1'), `the A1 viewer gets 404 for ${path}, with no bytes or label`);
		}
		const b = (await form('/sign-in', { identity: 'client-b/b-editor' })).headers.get('set-cookie')?.split(';')[0] ?? '';
		check(b.startsWith('clearcase_session='), 'a client B identity signs in at the identity double');
		const wrong = await http('/cases', { cookie: b });
		check(wrong.status === 401 && wrong.text.includes('data-denial-code="wrong-client"'), 'client A\'s deployment refuses a client B session: 401 wrong-client');
		const wrongOriginal = await http('/cases/case-b1/originals/b1-letter', { cookie: b });
		check(wrongOriginal.status === 401 && !wrongOriginal.text.includes('Synthetic original'), 'a client B session gets 401 and no bytes for B\'s original on A\'s deployment');
		const events = a.query("SELECT action, outcome, object_id, case_id FROM audit_event ORDER BY at");
		const has = (action: string, outcome: string, objectId: string) => events.some((e) => e.action === action && e.outcome === outcome && e.object_id === objectId);
		check(has('asset.read-original', 'succeeded', 'a1-letter'), 'the delivered original has a succeeded audit event in D1');
		check(has('asset.read-original', 'refused', 'a1-letter'), 'the refused Range has a refused audit event in D1, not a delivery');
		check(has('case.read', 'denied', 'case-a2') && has('asset.read-original', 'denied', 'a2-statement'), 'the wrong-case reads have denied audit events in D1');
		check(has('case.list', 'denied', 'client-a') && has('asset.read-original', 'denied', 'b1-letter'), 'the wrong-client requests have denied audit events in D1');
		check(events.every((e) => e.case_id === null || ['case-a1', 'case-a2', 'case-b1'].includes(String(e.case_id))), 'every audit event is scoped to a fixture case or none');
	});

	await leg('sign-out', async (check) => {
		const out = await form('/sign-out', {}, { cookie: viewer });
		check(out.status === 303 && out.headers.get('location') === '/sign-in', 'the sign-out action redirects 303 to /sign-in');
		const after = await http('/cases', { cookie: viewer });
		check(after.status === 401 && after.text.includes('data-denial-code="invalid-session"'), 'the signed-out session is refused 401 invalid-session at once');
		const scan = scanArtifact({ root: a.root, profile: 'hosted-gate' });
		check(scan.errors.length === 0, `the served hosted-gate artifact holds no memory double and no local-only import (${scan.files} emitted modules)`);
	});
	return legs;
}
