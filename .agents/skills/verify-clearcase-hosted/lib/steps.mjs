// The hosted feature map's drive steps, one per mapped feature (../features/<feature>.md), in the order a user takes
// them. Each acts through Chromium over CDP the way a user does (real controls, real form posts, a real download),
// checks the resulting state through a second view (cookies, an in-page fetch, the downloaded bytes) and returns its
// evidence; a thrown error fails it and every later step is NOT RUN. Owners of the real boundaries (GRS-113 identity,
// GRS-115 storage and assets) change their feature's step here when the double is replaced.
//
// The context x: x.page (main tab: evaluate, waitFor, navigate, sessionId), x.b (browser), x.app (origin),
// x.fixture (tests/hosted-foundation/runtime/gate-fixture.ts), x.newPage(opts), x.click(sel[, page]),
// x.select(sel, value[, page]), x.shot(name[, page]), x.inPageFetch(path[, init, page]), x.save(rel, bytes).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const IDENTITY = 'client-a/a-viewer';
export const WRONG_CLIENT_IDENTITY = 'client-b/b-editor';
const LETTER = '/cases/case-a1/originals/a1-letter';

async function signIn(x, page, identity) {
	await page.navigate(`${x.app}/`);
	await page.waitFor(`location.pathname === '/sign-in' && !!document.querySelector('[data-auth-provider=double]') && !!document.querySelector('#test-identity')`);
	const options = await page.evaluate(`[...document.querySelectorAll('#test-identity option')].map((o) => o.value)`);
	must(options.includes(identity), `#test-identity offers ${JSON.stringify(options)}, not ${identity}`);
	await x.select('#test-identity', identity, page);
	const form = await x.shot(`sign-in-form-${identity.split('/')[1]}`, page);
	await x.click('#sign-in', page);
	return { options, form };
}

export const steps = [
	{
		id: 'sign-in', feature: 'identity-sign-in', title: `Sign in as the test identity ${IDENTITY}: / redirects to /sign-in, choose the identity, submit`,
		async run(x) {
			const { options, form } = await signIn(x, x.page, IDENTITY);
			await x.page.waitFor(`location.pathname === '/cases' && !!document.querySelector('[data-auth-state=signed-in]')`, 20000);
			const who = await x.page.evaluate(`document.querySelector('[data-auth-state=signed-in] p')?.textContent.trim()`);
			must(who === 'Signed in as a-viewer.', `the signed-in banner says ${JSON.stringify(who)}`);
			const { cookies } = await x.b.send('Network.getCookies', { urls: [x.app] }, x.page.sessionId);
			const session = cookies.find((c) => c.name === 'clearcase_session');
			must(session?.httpOnly === true && session.sameSite === 'Lax', `the session cookie is ${JSON.stringify(session)}`);
			must(!(await x.page.evaluate('document.cookie')).includes('clearcase_session'), 'page script can read the session cookie');
			return { options, who, cookie: { httpOnly: session.httpOnly, sameSite: session.sameSite, path: session.path }, form, shot: await x.shot('signed-in-cases') };
		},
	},
	{
		id: 'open-case', feature: 'case-open', title: 'Open the provisioned case A1 from /cases: its stable id, ResultsState pending, originals, user work apart',
		async run(x) {
			const listed = await x.page.evaluate(`[...document.querySelectorAll('a[data-action=open-case]')].map((a) => a.dataset.caseId)`);
			must(JSON.stringify(listed) === '["case-a1"]', `/cases lists ${JSON.stringify(listed)}, expected only case-a1 (a-viewer's one grant)`);
			await x.click('a[data-action=open-case][data-case-id=case-a1]');
			await x.page.waitFor(`location.pathname === '/cases/case-a1' && document.querySelector('h1[data-case-id]')?.dataset.caseId === 'case-a1'`, 20000);
			const r = await x.page.evaluate(`({ title: document.querySelector('h1').textContent.trim(), results: document.querySelector('[data-results-state]')?.dataset.resultsState ?? null,
				originals: document.querySelector('[data-originals-state]')?.dataset.originalsState, userWork: document.querySelector('[data-user-work-state]')?.dataset.userWorkState,
				assets: [...document.querySelectorAll('a[data-action=open-original]')].map((a) => a.dataset.assetId) })`);
			must(r.title === 'Synthetic matter A1', `the case heading is ${JSON.stringify(r.title)}`);
			must(r.results === 'pending', `ResultsState is ${r.results}, expected pending (case A1 has no publication)`);
			must(r.originals === 'available' && JSON.stringify(r.assets) === '["a1-letter","a1-note"]', `originals ${r.originals} ${JSON.stringify(r.assets)}`);
			must(r.userWork === 'unavailable', `user work is ${r.userWork}, expected unavailable apart from results`);
			return { ...r, shot: await x.shot('case-a1') };
		},
	},
	{
		id: 'open-original', feature: 'original-open', title: 'Open the original a1-letter: the browser downloads the whole file, whose SHA-256 is the fixture\'s',
		async run(x) {
			const letter = x.fixture.originals.find((o) => o.asset_id === 'a1-letter');
			const sel = 'a[data-action=open-original][data-asset-id=a1-letter]';
			const href = await x.page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('href')`);
			must(href === LETTER, `the original's link is ${href}`);
			const began = x.b.once((m) => m.method === 'Browser.downloadWillBegin' && m.params.url === x.app + LETTER, 15000);
			const done = x.b.once((m) => m.method === 'Browser.downloadProgress' && ['completed', 'canceled'].includes(m.params.state), 15000);
			await x.click(sel);
			const w = await began, d = await done;
			must(d.params.state === 'completed' && d.params.guid === w.params.guid, `the download ended ${d.params.state}`);
			const bytes = readFileSync(join(x.b.downloadDir, w.params.guid));
			must(bytes.length === letter.size && sha256(bytes) === letter.sha256, `downloaded ${bytes.length} bytes, sha256 ${sha256(bytes)}; the fixture records ${letter.size}, ${letter.sha256}`);
			const saved = x.save(`downloads/${w.params.suggestedFilename}`, bytes);
			const second = await x.inPageFetch(LETTER);
			must(second.status === 200 && second.sha256 === letter.sha256, `a second GET answered ${second.status}, sha256 ${second.sha256}`);
			must(second.headers['content-type']?.startsWith('application/pdf') && second.headers['content-disposition']?.startsWith('attachment;') && second.headers['x-content-type-options'] === 'nosniff', `headers ${JSON.stringify(second.headers)}`);
			const ranged = await x.inPageFetch(LETTER, { headers: { range: 'bytes=0-63' } });
			must(ranged.status === 416 && ranged.size === 0, `a Range request answered ${ranged.status} with ${ranged.size} bytes`);
			must(await x.page.evaluate('location.pathname') === '/cases/case-a1', 'opening the original navigated away from the case');
			return { suggestedFilename: w.params.suggestedFilename, size: bytes.length, sha256: sha256(bytes), saved, headers: second.headers, range: ranged.status, shot: await x.shot('original-downloaded') };
		},
	},
	{
		id: 'wrong-client', feature: 'access-denied', title: `Sign in as ${WRONG_CLIENT_IDENTITY} in a second browser context: client A's deployment denies it, and no byte of A's original reaches it`,
		async run(x) {
			const other = await x.newPage({ fresh: true });
			try {
				const { form } = await signIn(x, other, WRONG_CLIENT_IDENTITY);
				await other.waitFor(`location.pathname === '/cases' && !!document.querySelector('[data-denial-code]')`, 20000);
				const page = await other.evaluate(`({ code: document.querySelector('[data-denial-code]').dataset.denialCode, status: document.querySelector('[data-denial-code]').dataset.status,
					signedIn: !!document.querySelector('[data-auth-state=signed-in]'), cases: document.querySelectorAll('a[data-case-id]').length, text: document.querySelector('main').innerText })`);
				must(page.code === 'wrong-client' && page.status === '401', `/cases for a client B session shows ${page.code} ${page.status}`);
				must(!page.signedIn && page.cases === 0 && !/Synthetic matter/.test(page.text), 'the denial page shows signed-in state or case data');
				const shot = await x.shot('wrong-client-denied', other);
				const fetched = await x.inPageFetch(LETTER, {}, other);
				must(fetched.status === 401 && !fetched.pdf && !fetched.synthetic, `client B fetching A's original got ${fetched.status}, ${fetched.size} bytes`);
				const downloads = x.b.events.downloads.length;
				await other.navigate(`${x.app}${LETTER}`);
				await other.waitFor(`document.readyState === 'complete' && !!document.querySelector('[data-denial-code]')`, 15000);
				const nav = await other.evaluate(`({ code: document.querySelector('[data-denial-code]').dataset.denialCode, status: document.querySelector('[data-denial-code]').dataset.status })`);
				must(nav.code === 'wrong-client' && nav.status === '401' && x.b.events.downloads.length === downloads, `opening A's original as client B showed ${JSON.stringify(nav)}, downloads ${x.b.events.downloads.length - downloads}`);
				const wrongCase = await x.inPageFetch('/cases/case-a1/originals/b1-letter');
				must(wrongCase.status === 404 && !wrongCase.pdf, `a-viewer asking for B's original under case A1 got ${wrongCase.status}`);
				return { form, page: { code: page.code, status: page.status }, fetch: { status: fetched.status, size: fetched.size }, navigation: nav, wrongCase: { status: wrongCase.status, size: wrongCase.size }, shot, shotOriginal: await x.shot('wrong-client-original', other) };
			} finally {
				await other.close();
			}
		},
	},
];
