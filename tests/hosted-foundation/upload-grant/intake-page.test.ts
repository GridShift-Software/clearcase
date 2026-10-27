// What the client intake page may learn about upload eligibility (alpha hardening, lane auth-routing). The page load must say
// whether the signed-in reader holds an effective upload grant so that a reader without one is told so instead of being offered a
// form the first send refuses. The answer is advisory and unaudited: the write path still runs the audited authorizer, and the
// grant rules (uploadEffective, the authorizer) are untouched. SYNTHETIC world and doubles, component evidence only.
import { describe, expect, it } from 'vitest';
import type { Identity, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { createUploadHolding } from '../../../src/lib/tenancy/upload-capability.ts';
import { MemoryOriginals, SqliteD1 } from '../../hosted-smoke/intake/doubles.ts';
import { MIGRATIONS, compose, repositoryFor } from '../../hosted-smoke/intake/harness.ts';
import { load } from '../../../deploy/client/routes/client/intake/[caseId]/+page.server.ts';
import { CASE_1, CASE_2, CLIENT_A, SESSION, client, staff, world } from './world.ts';

const ORIGIN = 'https://client-a.clearcase.test', USER = client('user_a');
const BUDGET = { maxMetadataBytes: 2048, maxFileBytes: 4096 };
type W = Awaited<ReturnType<typeof world>>;

function setup(w: W, o: { holding?: boolean } = {}) {
	const mayUpload = createUploadHolding({ deployment: w.deployment, uploads: w.uploads, now: w.now });
	compose({ clientId: CLIENT_A, budget: BUDGET, authorizeUpload: w.authorize, ...(o.holding === false ? {} : { mayUpload }), originals: new MemoryOriginals(), repository: repositoryFor(new SqliteD1(MIGRATIONS)), now: () => new Date('2026-10-25T08:00:00.000Z') });
}
const who = (w: W, p: Principal, sessionId: SessionId = SESSION): Identity => ({
	kind: 'verified', principal: p, sessionId, clientId: CLIENT_A,
	checkRevocation: () => w.session({ principal: p, sessionId }),
	authorize: (a) => w.caseAuthorizer.authorizeCase({ principal: p, sessionId, caseId: a.caseId, operation: a.operation }),
});
const page = (caseId: string, identity: Identity) => {
	const url = new URL(`/client/intake/${caseId}`, ORIGIN);
	return load({ request: new Request(url), url, params: { caseId }, locals: { identity }, platform: undefined } as never) as Promise<{ available: boolean; canUpload?: boolean; submissions: unknown[] }>;
};

describe('the intake page load and upload eligibility', () => {
	it('says a reader with case access and an effective upload grant may upload', async () => {
		const w = await world();
		w.seedCase(USER, 'viewer', CASE_1);
		await w.issue(USER, CASE_1, 'op-1');
		setup(w);
		expect(await page(CASE_1, who(w, USER))).toMatchObject({ available: true, canUpload: true });
	});

	it('says a reader with case access and no upload grant may not, and still lists the case', async () => {
		const w = await world();
		w.seedCase(USER, 'viewer', CASE_1);
		setup(w);
		expect(await page(CASE_1, who(w, USER))).toMatchObject({ available: true, canUpload: false, submissions: [] });
	});

	it.each([
		['an upload grant on another case', async (w: W) => { w.seedCase(USER, 'viewer', CASE_1); w.seedCase(USER, 'viewer', CASE_2); await w.issue(USER, CASE_2, 'op-1'); }],
		['a revoked upload grant', async (w: W) => {
			w.seedCase(USER, 'viewer', CASE_1);
			const g = await w.issue(USER, CASE_1, 'op-1');
			if (g.kind !== 'applied') throw new Error('setup');
			await w.provisioning.revoke({ operator: 'provisioning-run-1', operationId: 'rev-1', grantId: g.grant.grantId, expectedVersion: g.grant.version });
		}],
		['an expired upload grant', async (w: W) => { w.seedCase(USER, 'viewer', CASE_1); await w.issue(USER, CASE_1, 'op-1', { expiresAt: '2026-10-25T09:00:00.000Z' }); w.advance(2 * 3600_000); }],
	])('says a reader with %s may not upload', async (_name, arrange) => {
		const w = await world();
		await arrange(w);
		setup(w);
		expect((await page(CASE_1, who(w, USER))).canUpload).toBe(false);
	});

	it('writes no audit event for the answer: only the read of the case is recorded, never an upload success or denial', async () => {
		const w = await world();
		w.seedCase(USER, 'viewer', CASE_1);
		setup(w);
		await page(CASE_1, who(w, USER));
		await page(CASE_1, who(w, USER));
		expect(w.events.filter((e) => (e as { action?: string }).action === 'case.upload-originals')).toEqual([]);
	});

	it('leaves the answer out when the grant lookup is down, so the page keeps the form and the audited write path decides', async () => {
		const w = await world();
		w.seedCase(USER, 'viewer', CASE_1);
		await w.issue(USER, CASE_1, 'op-1');
		setup(w);
		w.state.uploadsFail = true;
		const out = await page(CASE_1, who(w, USER));
		expect(out.available).toBe(true);
		expect(out.canUpload).toBeUndefined();
	});

	it('leaves the answer out when the composition has no holding port', async () => {
		const w = await world();
		w.seedCase(USER, 'viewer', CASE_1);
		setup(w, { holding: false });
		expect((await page(CASE_1, who(w, USER))).canUpload).toBeUndefined();
	});

	it('still refuses a staff session or an unassigned case before saying anything about uploads', async () => {
		const w = await world();
		w.seedCase(USER, 'viewer', CASE_1);
		await w.issue(USER, CASE_1, 'op-1');
		setup(w);
		await expect(page(CASE_2, who(w, USER))).rejects.toMatchObject({ status: 404 });
		await expect(page(CASE_1, who(w, staff('s')))).rejects.toMatchObject({ status: 404 });
	});
});
