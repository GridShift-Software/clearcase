#!/usr/bin/env bun
// Offline browser suite of the evidence views (GRS-14, CC-04), run by `bun run --bun test:e2e` after the pilot suites,
// in its own network namespace. One synthetic case (GRS-10's converter through tests/e2e/pilot/lib/fixtures.ts), the
// production entry under Bun on a fresh data directory, real clicks and keys in Chromium. Every scenario asserts its
// view's document title and heading focus after navigating from the sidebar. Results: per scenario
// $CLEARCASE_E2E_OUT/evidence/<id>.json and $CLEARCASE_E2E_OUT/evidence/summary.json ({scenarios: [{id, view, pass}]}).
// Exit 0 only when the offline proof and every scenario pass.
process.env.CANARY_PORT ??= '43599';
const { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { bunIdentity } = await import('../pilot/lib/server.mjs');
const { outDir } = await import('../pilot/lib/record.mjs');
const { appServer } = await import('../pilot/suite/context.mjs');
const { INIT, openPage } = await import('../pilot/suite/browser.mjs');
const { buildCase, row } = await import('../pilot/lib/fixtures.ts');

const ROOT = resolve(process.env.E2E_ROOT ?? join(import.meta.dirname, '..', '..', '..'));
const BUILD = resolve(process.env.E2E_BUILD_DIR ?? join(ROOT, 'build'));
const OUT = join(outDir(), 'evidence');
mkdirSync(OUT, { recursive: true });
const J = JSON.stringify;
const stamp = existsSync(join(BUILD, 'clearcase-build.json')) ? JSON.parse(readFileSync(join(BUILD, 'clearcase-build.json'), 'utf8')) : null;

// ---- results ---------------------------------------------------------------------------------------------------------
const scenarios = [];
const t0 = Date.now();
async function scenario(id, view, title, fn) {
	const s0 = Date.now();
	let pass = false, evidence;
	try { const r = await fn(); pass = !!r.pass; evidence = r.evidence; } catch (e) { evidence = { error: String(e?.stack ?? e).slice(0, 4000) }; }
	const rec = { id, view, title, pass, ms: Date.now() - s0, evidence };
	scenarios.push(rec);
	writeFileSync(join(OUT, `${id}.json`), J(rec, null, 1));
	console.log(`${pass ? 'PASS' : 'FAIL'}    ${id} [${view}] ${title}`);
	return pass;
}
const finish = (extra = {}) => {
	const ok = scenarios.length > 0 && scenarios.every((s) => s.pass);
	writeFileSync(join(OUT, 'summary.json'), J({ ok, build: BUILD, buildStamp: stamp, bun: bunIdentity(), ms: Date.now() - t0, ...extra, scenarios: scenarios.map(({ id, view, pass, title }) => ({ id, view, pass, title })) }, null, 1));
	console.log(`evidence suite: ${scenarios.filter((s) => s.pass).length} PASS, ${scenarios.filter((s) => !s.pass).length} FAIL -> ${join(OUT, 'summary.json')}`);
	return ok;
};

const offline = await proveOffline();
if (!offline.pass) {
	scenarios.push({ id: 'NET-OFFLINE', view: 'none', title: 'the run is offline', pass: false, evidence: offline });
	process.exit(finish() ? 0 : 1);
}

// ---- the synthetic case ----------------------------------------------------------------------------------------------
const enc = (s) => new TextEncoder().encode(s);
const BULK = 70; // Original rows beyond one 60-row Documents page and one 50-row Search page
const originals = {};
const extra = [];
for (let i = 0; i < BULK; i++) {
	const file = `BULK/OD-${200 + i} Bulk ${i}.txt`;
	originals[file] = enc(`Synthetic bulk document ${i}\n`);
	// two types, one a prefix of the other, and dates that would interleave them under v5's concatenated sort key
	extra.push(row(`OD-${200 + i}`, 100 + i, file, originals[file].byteLength, { date: `1995-0${1 + (i % 9)}-1${i % 10}`, doc_type: i % 2 ? 'invoice' : 'invoice breakdown', subject: `Synthetic bulk ${i}`, excerpt: `Bulk excerpt ${i}.`, amount: String(10 + i) }));
}
const ADD = [['VDM-901', 'the cat sat', 'report', '1996-02-02'], ['VDM-902', 'the dog sat', 'report', '1996-01-01'], ['VDM-903', '', 'other', '']];
for (const [ref, excerpt, type, date] of ADD) {
	const file = `ADDITIONAL/${ref} Synthetic.txt`;
	originals[file] = enc(`Synthetic additional ${ref}\n`);
	extra.push(row(ref, 300 + extra.length, file, originals[file].byteLength, { bundle: 'Additional', doc_type: type, date, excerpt, subject: `Synthetic additional ${ref}` }));
}
let chronology;
const tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-evidence-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const sc = await buildCase(join(tmp, 'case-src'), {
	caseId: 'e2e-evidence', originals, rows: extra,
	edit: (r) => {
		r.DATA.filings.registerSeed.push({ fdate: '', filing: 'Synthetic second seed', fparty: 'Respondent', rdate: '', ref: 'EM-0001', response: 'Synthetic reply', status: '' });
		r.DATA.people.push({ name: 'Synthetic Mailer', email: 'no-reply@example.invalid', org: 'Synthetic Attorneys Inc', sent: 9, received: 0, total: 9, role: '' });
		r.DATA.people.push({ name: 'Synthetic Counsel', email: 'counsel@example.invalid', org: 'Org B', sent: 1, received: 1, total: 2, role: 'attorney' });
		chronology = r.DATA.chronology.map((x) => ({ ...x }));
	},
});

// ---- server and browser ----------------------------------------------------------------------------------------------
const A = appServer({ name: 'evidence', root: ROOT, buildDir: BUILD, port: 43510, origPort: 43511, dir: tmp });
const DL_HOOK = `(() => { window.__dl = []; const C = URL.createObjectURL.bind(URL); const blobs = new Map();
	URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { window.__dl.push({ name: this.download, blob: o }); return; } return click.call(this); };
})()`;
let b;
const R = (view) => `document.querySelector('main#main')?.dataset.ready === ${J(view)} && !document.querySelector('main#main')?.dataset.busy`;
// the case part of page titles: the package's view-content _shell.documentTitle, else the case id (the app's fallback)
const shellTitle = (() => { const f = sc.files.get('datasets/view-content.json'); const v = f ? JSON.parse(new TextDecoder().decode(f)).data?._shell?.documentTitle : undefined; return typeof v === 'string' && v.trim() ? v : null; })();
const kase = shellTitle ?? 'e2e-evidence';
const titleOf = (label) => `${label} · ${kase} · ClearCase`;
let exitOk = false;
try {
	await A.start();
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	if (!imp.importId) throw new Error(`import failed: ${imp.status} ${imp.text?.slice(0, 300)}`);
	await A.c.activate(imp.importId);
	if ((await A.c.activeVersion()) !== sc.resultsVersion) throw new Error('activation failed');
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const p = await openPage(b, { initScript: `${INIT};${DL_HOOK}` });
	const V = A.v(sc.resultsVersion);
	const reqMark = () => b.events.requests.length;
	const reqsSince = (m) => b.events.requests.slice(m).map((x) => x.url);
	const corpusReloads = (urls) => urls.filter((u) => /\/api\/v\/[^/]+\/chronology/.test(u));
	const takeDownloads = () => p.evaluate(`Promise.all(window.__dl.splice(0).map(async (d) => ({ name: d.name, text: await d.blob.text() })))`);
	const rows = (sel) => p.evaluate(`[...document.querySelectorAll(${J(sel)})].map((r) => r.dataset.ref ?? r.dataset.key)`);
	/** From the overview, click the view's sidebar link; the title, the heading and where focus is. */
	async function viaNav(view, label) {
		await p.goto(`${V}/overview`, R('overview'));
		await p.click(`#nav-${view}`);
		await p.waitFor(`${R(view)} && document.title === ${J(titleOf(label))}`, 15000).catch(() => null);
		await sleep(80);
		const a = await p.active();
		const got = { title: await p.evaluate('document.title'), h1: await p.evaluate(`document.querySelector('main#main h1')?.textContent.trim() ?? null`), focus: a?.heading ? 'heading' : a?.tag ?? null };
		return { got, ok: got.title === titleOf(label) && got.h1 === label && got.focus === 'heading' };
	}
	const byRef = new Map(chronology.map((x) => [x.ref, x]));
	const collator = new Intl.Collator('en-US');

	// E2/E3 (documents): every bundle, filter, pagination, order, Back, no whole-corpus reload per change
	await scenario('E-DOCS', 'documents', 'Documents: every imported bundle selectable (Additional included), filter resets to page 1, Next keeps bundle and filter in the URL, type-then-date order, Back from a document keeps the state, no whole-corpus reload per change', async () => {
		const nav = await viaNav('documents', 'Documents');
		const buttons = await p.evaluate(`[...document.querySelectorAll('#main .toolbar button')].map((b) => b.textContent.trim())`);
		const originalN = chronology.filter((x) => x.bundle === 'Original').length;
		const page1 = await rows('#documents-table tbody tr[data-ref]');
		const expected = chronology.filter((x) => x.bundle === 'Original').map((x, i) => ({ ...x, i })).sort((x, y) => collator.compare(x.doc_type, y.doc_type) || (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) || x.i - y.i).map((x) => x.ref);
		const m = reqMark();
		await p.click('#documents-pager button:last-of-type');
		await p.waitFor(`document.getElementById('main').dataset.page === '2' && ${R('documents')}`, 15000);
		const page2 = await rows('#documents-table tbody tr[data-ref]');
		await p.type('#doc-filter', 'bulk 1');
		await p.waitFor(`document.getElementById('main').dataset.q === 'bulk 1' && ${R('documents')}`, 15000);
		const filtered = await rows('#documents-table tbody tr[data-ref]');
		const afterFilter = { page: await p.evaluate(`document.getElementById('main').dataset.page`), url: await p.evaluate('location.search') };
		const expectFiltered = expected.filter((r) => `${byRef.get(r).filename} ${r} ${byRef.get(r).subject} ${byRef.get(r).excerpt}`.toLowerCase().includes('bulk 1'));
		await p.evaluate(`[...document.querySelectorAll('#main .toolbar button')].find((b) => b.textContent.startsWith('Additional'))?.setAttribute('data-e2e', 'additional')`);
		await p.click('[data-e2e="additional"]');
		await p.waitFor(`document.getElementById('main').dataset.bundle === 'Additional' && ${R('documents')}`, 15000);
		const additional = await rows('#documents-table tbody tr[data-ref]');
		const filterKept = await p.evaluate(`document.getElementById('doc-filter').value`);
		const reloads = corpusReloads(reqsSince(m));
		// Back from a document returns to the same bundle and filter
		await p.evaluate(`document.getElementById('doc-filter').value = ''`);
		await p.type('#doc-filter', 'synthetic');
		await p.waitFor(`document.getElementById('main').dataset.q === 'synthetic' && ${R('documents')}`, 15000);
		const before = { url: await p.evaluate('location.search'), rows: await rows('#documents-table tbody tr[data-ref]') };
		await p.click('#documents-table tbody tr a.doc');
		await p.waitFor(`location.pathname.includes('/doc/')`, 15000);
		await sleep(100);
		await p.evaluate('history.back()');
		await p.waitFor(`location.pathname.endsWith('/evidence/documents') && ${R('documents')}`, 15000);
		await sleep(100);
		const after = { url: await p.evaluate('location.search'), rows: await rows('#documents-table tbody tr[data-ref]'), filter: await p.evaluate(`document.getElementById('doc-filter').value`) };
		const additionalAll = J(before.rows) === J(['VDM-902', 'VDM-901', 'VDM-903'].sort((x, y) => collator.compare(byRef.get(x).doc_type, byRef.get(y).doc_type) || (byRef.get(x).date < byRef.get(y).date ? -1 : byRef.get(x).date > byRef.get(y).date ? 1 : 0)));
		const checks = {
			nav: nav.ok, additionalButton: buttons.includes('Additional (3)'), originalButton: buttons.includes(`Original (${originalN})`),
			page1: J(page1) === J(expected.slice(0, 60)), page2: J(page2) === J(expected.slice(60)),
			filtered: J(filtered) === J(expectFiltered.slice(0, 60)) && filtered.length === 11, filterResetsPage: afterFilter.page === '1' && /q=bulk/.test(afterFilter.url) && !/page=/.test(afterFilter.url),
			// v5 keeps the filter when the bundle changes, and no Additional row matches it
			additional: J(additional) === '[]', filterKeptAcrossBundle: filterKept === 'bulk 1',
			additionalAll, noCorpusReload: reloads.length === 0, backKeepsState: before.url === after.url && J(before.rows) === J(after.rows) && after.filter === 'synthetic' && /bundle=Additional/.test(after.url),
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, buttons, page1Len: page1.length, page2Len: page2.length, filtered, additional, reloads, before, after } };
	});

	// E1-E6 (search): literal synthetic results, bundle and type, pagination keeps the query, export order, BA-15, BA-08
	await scenario('E-SEARCH', 'search', 'Advanced Search: literal results, bundle + type filter (Additional), the query kept across pagination, export order = page order (BA-17), reversed date and amount intervals rejected apart from a genuine empty result (BA-15), coverage counted from the rows (BA-08), no whole-corpus reload', async () => {
		const nav = await viaNav('search', 'Advanced Search');
		const cov = await p.evaluate(`(() => { const e = document.getElementById('search-coverage'); return { ...e.dataset, text: e.textContent.replace(/\\s+/g, ' ').trim() }; })()`);
		const expectCov = { documents: String(chronology.length), withExcerpt: String(chronology.filter((x) => x.excerpt).length), none: String(chronology.filter((x) => x.text_status === 'none').length), pending: String(chronology.filter((x) => x.text_status === 'pending').length), maxExcerpt: String(Math.max(...chronology.map((x) => (x.excerpt ?? '').length))) };
		const m = reqMark();
		const submit = async (fields) => {
			await p.goto(`${V}/evidence/search`, R('search'));
			for (const [id, v] of Object.entries(fields)) {
				if (id === 'sb' || id === 'st' || id === 'sst') await p.evaluate(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
				else await p.evaluate(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
			}
			await p.click('#search-run');
			await p.waitFor(`document.getElementById('main').dataset.result !== 'idle' && ${R('search')}`, 15000);
			return p.evaluate(`({ result: document.getElementById('main').dataset.result, refs: [...document.querySelectorAll('#search-table tbody tr[data-ref]')].map((r) => r.dataset.ref), count: document.getElementById('search-count')?.textContent.trim() ?? null, invalid: document.getElementById('search-invalid')?.textContent.trim() ?? null, empty: document.getElementById('search-empty')?.textContent.trim() ?? null, url: location.search })`);
		};
		const bulk = await submit({ sq: 'Synthetic bulk' });
		const bulkExpected = chronology.filter((x) => /synthetic bulk/i.test(`${x.filename} ${x.ref} ${x.subject} ${x.sender} ${x.to} ${x.excerpt}`)).map((x) => x.ref);
		await p.click('#search-pager button:nth-of-type(2)');
		await p.waitFor(`document.getElementById('main').dataset.page === '2' && ${R('search')}`, 15000);
		const page2 = { refs: await rows('#search-table tbody tr[data-ref]'), query: await p.evaluate(`document.getElementById('sq').value`), url: await p.evaluate('location.search') };
		await p.click('#search-export');
		await p.waitFor('window.__dl.length > 0', 15000);
		const [dl] = await takeDownloads();
		const exported = dl.text.split('\r\n').slice(1).map((l) => l.split(',')[0]);
		const additionalReport = await submit({ sb: 'Additional', st: 'report' });
		const reversedDate = await submit({ sf: '1999-12-31', sto: '1999-01-01' });
		const reversedAmount = await submit({ samin: '10', samax: '1' });
		const notNumber = await submit({ samin: 'abc' });
		const genuineEmpty = await submit({ sf: '1990-01-01', sto: '1990-01-02' });
		const reloads = corpusReloads(reqsSince(m));
		const checks = {
			nav: nav.ok,
			coverage: Object.entries(expectCov).every(([k, v]) => cov[k] === v) && /not the full text/.test(cov.text) && !/full-document|full text search/i.test(cov.text),
			literal: bulk.result === 'results' && J(bulk.refs) === J(bulkExpected.slice(0, 50)) && bulk.count === `Showing 1–50 of ${bulkExpected.length} results`,
			queryKeptAcrossPages: J(page2.refs) === J(bulkExpected.slice(50)) && page2.query === 'Synthetic bulk' && /q=Synthetic\+bulk/.test(page2.url) && /page=2/.test(page2.url),
			exportOrder: dl.name === 'search.csv' && J(exported) === J(bulkExpected),
			bundleAndType: J(additionalReport.refs) === J(['VDM-901', 'VDM-902']),
			reversedDate: reversedDate.result === 'invalid' && /From date is after To date/.test(reversedDate.invalid ?? '') && reversedDate.refs.length === 0 && reversedDate.count === null,
			reversedAmount: reversedAmount.result === 'invalid' && /Amount min is greater than Amount max/.test(reversedAmount.invalid ?? ''),
			notANumber: notNumber.result === 'invalid' && /Amount min is not a number/.test(notNumber.invalid ?? ''),
			genuineEmpty: genuineEmpty.result === 'empty' && genuineEmpty.invalid === null && /No documents match/.test(genuineEmpty.empty ?? '') && genuineEmpty.count === 'Showing 0–0 of 0 results',
			noCorpusReload: reloads.length === 0,
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, cov, expectCov, bulk: { n: bulk.refs.length, count: bulk.count }, page2, exportedN: exported.length, additionalReport: additionalReport.refs, reversedDate, reversedAmount, notNumber, genuineEmpty, reloads } };
	});

	// E7 (contracts): open a contract and its citation
	await scenario('E-CONTRACTS', 'contracts_tab', 'Contracts: the classification disclosure (BA-05), a contract row opens its document page with the original (two-click flow), export columns', async () => {
		const nav = await viaNav('contracts_tab', 'Contracts');
		const disclosure = await p.evaluate(`document.getElementById('classification-status')?.dataset.verification ?? null`);
		const contract = await p.evaluate(`(() => { const r = document.querySelector('#main tr[data-ref="OD-001"]'); return r ? [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()) : null; })()`);
		await p.click('#export-contracts');
		await p.waitFor('window.__dl.length > 0', 15000);
		const [dl] = await takeDownloads();
		await p.click('#main tr[data-ref="OD-001"] a.doc');
		await p.waitFor(`document.querySelector('main#main')?.dataset.ready === 'doc:OD-001'`, 15000);
		const doc = await p.evaluate(`({ path: location.pathname, h1: document.querySelector('main#main h1')?.textContent.trim() ?? null, original: document.querySelector('[data-original-state]')?.dataset.originalState ?? null, open: [...document.querySelectorAll('section.original a')].map((a) => a.textContent.trim()).filter(Boolean) })`);
		const checks = {
			nav: nav.ok, disclosure: disclosure === 'unverified', row: contract?.[0] === 'OD-001' && contract?.[5] === 'open ↗',
			export: dl.name === 'contracts.csv' && dl.text.split('\r\n')[0] === 'group,ref,date,title,note,text_status,url' && dl.text.split('\r\n').length === 2,
			citation: doc.path.endsWith('/doc/OD-001') && doc.original === 'present' && doc.open.length > 0,
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, contract, exportHead: dl.text.split('\r\n')[0], doc } };
	});

	// E8 (people, entities): a person and an entity relationship; an automated sender stays raw and unverified (BA-07)
	await scenario('E-PEOPLE', 'people', 'People: the inferred-identity disclosure (BA-07); a synthetic automated sender keeps its raw values, is marked as an automated address and gets no attorney or verified label; a role shows only as inferred', async () => {
		const nav = await viaNav('people', 'People');
		const t = await p.evaluate(`({ head: [...document.querySelectorAll('#people-table th')].map((x) => x.textContent.trim()), rows: [...document.querySelectorAll('#people-table tbody tr')].map((r) => ({ automated: r.dataset.automated ?? null, address: r.querySelector('.addr')?.textContent ?? null, hint: r.querySelector('.hint')?.textContent.trim() ?? null, cells: [...r.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()), badges: [...r.querySelectorAll('.badge, .chip')].map((x) => x.textContent) })), disclosure: document.getElementById('identity-status')?.dataset.verification ?? null })`);
		const mailer = t.rows.find((r) => r.cells[0] === 'Synthetic Mailer');
		const counsel = t.rows.find((r) => r.cells[0] === 'Synthetic Counsel');
		const rest = mailer ? mailer.cells.join(' | ').replace('Synthetic Attorneys Inc', '') : '';
		const checks = {
			nav: nav.ok, disclosure: t.disclosure === 'unverified',
			rawSender: !!mailer && mailer.address === 'no-reply@example.invalid' && mailer.hint === 'automated address' && mailer.cells[2] === 'Synthetic Attorneys Inc' && mailer.automated === 'true',
			noAttorneyLabel: !!mailer && !/attorney/i.test(rest) && !/verified/i.test(mailer.cells.join(' ')) && mailer.badges.length === 0,
			roleInferred: t.head.includes('Role (inferred, unverified)') && counsel?.cells[3] === 'attorney' && !counsel.automated,
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, head: t.head, mailer, counsel } };
	});
	await scenario('E-ENTITIES', 'entity_ledger_tab', "Entities: the unverified-role disclosure (BA-07); a person's organisation is an entity with its imported role", async () => {
		const nav = await viaNav('entity_ledger_tab', 'Entities');
		const t = await p.evaluate(`({ rows: [...document.querySelectorAll('#entities-table tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim())), disclosure: document.getElementById('identity-status')?.dataset.verification ?? null })`);
		const person = chronology && { org: 'Org A Ltd' };
		const checks = { nav: nav.ok, disclosure: t.disclosure === 'unverified', relationship: t.rows.some((r) => r[0] === person.org && r[1] === 'Claimant') };
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, rows: t.rows } };
	});

	// E9 (filings): edit and reload a filing relationship; failed writes keep the input; restarts keep every row
	await scenario('E-FILINGS', 'filings_tab', 'Filings: BA-05 disclosure; add, edit a user row and a seed (overlay), delete a seed (overlay), reload; a busy store and a lost transport show an error, keep every typed field and write nothing, and one retry saves one row; graceful and SIGKILL restarts keep every row', async () => {
		const nav = await viaNav('filings_tab', 'Filings & Affidavits');
		const disclosure = await p.evaluate(`document.getElementById('classification-status')?.dataset.verification ?? null`);
		const reg = () => p.evaluate(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].map((r) => ({ key: r.dataset.key, state: r.dataset.state, cells: [...r.cells].slice(0, 7).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()) }))`);
		const fill = async (v) => { for (const [id, x] of Object.entries(v)) await p.evaluate(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(x)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`); };
		const typedValues = () => p.evaluate(`Object.fromEntries(['fl_filing', 'fl_fdate', 'fl_fparty', 'fl_response', 'fl_rdate', 'fl_ref'].map((id) => [id, document.getElementById(id)?.value ?? null]))`);
		const dbRows = () => ({ rows: A.work(`SELECT row_id, fields FROM register_row WHERE store = 'filings-register' ORDER BY row_id`), overlays: A.work(`SELECT seed_id, fields FROM seed_overlay WHERE dataset_key = 'filings' ORDER BY seed_id`) });
		const seeds0 = await reg();
		const entry = { fl_filing: 'Synthetic added filing', fl_fdate: '1997-03-04', fl_fparty: 'Synthetic party', fl_response: 'Synthetic response', fl_rdate: '1997-04-05', fl_ref: 'OD-002' };
		await fill(entry);
		await p.click('#register-add');
		await p.waitFor(`document.querySelectorAll('#filing-register tbody tr[data-key]').length === ${seeds0.length + 1}`, 15000);
		const added = await reg();
		const formReset = await typedValues();
		const userKey = added.at(-1).key;
		// edit the user row
		await p.click(`#filing-register tr[data-key=${J(userKey)}] .actions form:first-child button`);
		await p.waitFor(`document.getElementById('register-form')?.dataset.mode === 'edit' && document.getElementById('fl_filing').value === 'Synthetic added filing'`, 15000);
		await fill({ fl_filing: 'Synthetic edited filing' });
		await p.click('#register-save');
		await p.waitFor(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].some((r) => r.textContent.includes('Synthetic edited filing'))`, 15000);
		// edit the first seed, delete the second seed (both overlays; the seeds stay results)
		const [s1, s2] = seeds0;
		await p.goto(`${V}/evidence/filings_tab?edit=${encodeURIComponent(s1.key)}`, R('filings_tab'));
		await fill({ fl_response: 'Synthetic seed reply edited' });
		await p.click('#register-save');
		await p.waitFor(`document.querySelector('#filing-register tr[data-key=${J(s1.key)}]')?.dataset.state === 'edited'`, 15000);
		await p.click(`#filing-register tr[data-key=${J(s2.key)}] .actions form:last-child button`);
		await p.waitFor(`!document.querySelector('#filing-register tr[data-key=${J(s2.key)}]')`, 15000);
		const edited = await reg();
		await p.goto(`${V}/evidence/filings_tab`, R('filings_tab'));
		const reloaded = await reg();
		const db1 = dbRows();
		const seedsKept = A.results(`SELECT COUNT(*) AS n FROM seed WHERE dataset_key = 'filings'`)[0].n;

		// failed write 1: a busy store across the submit
		const busyEntry = { fl_filing: 'Synthetic busy filing', fl_fdate: '1997-05-06', fl_fparty: 'Busy party', fl_response: 'Busy response', fl_rdate: '1997-06-07', fl_ref: 'EM-0001' };
		await fill(busyEntry);
		const lock = new Database(join(A.dataDir, 'work.sqlite'));
		lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
		const lockedAt = Date.now();
		await p.click('#register-add');
		let busy;
		try {
			await p.waitFor(`!!document.getElementById('register-error')`, 30000);
			busy = { error: await p.evaluate(`document.getElementById('register-error').textContent.trim()`), typed: await typedValues(), rowsDuring: (await reg()).length };
			while (Date.now() - lockedAt < 12500) await sleep(100);
			busy.heldMs = Date.now() - lockedAt;
		} finally { lock.exec('ROLLBACK'); lock.close(); }
		busy.dbAfterRelease = dbRows().rows.length;
		await p.click('#register-add');
		await p.waitFor(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].some((r) => r.textContent.includes('Synthetic busy filing'))`, 20000);
		busy.retryRows = dbRows().rows.filter((r) => JSON.parse(r.fields).filing === 'Synthetic busy filing').length;

		// failed write 2: the transport is gone (the server is stopped before the submit)
		const lostEntry = { fl_filing: 'Synthetic lost filing', fl_fdate: '1997-07-08', fl_fparty: 'Lost party', fl_response: 'Lost response', fl_rdate: '1997-08-09', fl_ref: 'SD-001' };
		await fill(lostEntry);
		await A.stop();
		await p.click('#register-add');
		const lost = {};
		await p.waitFor(`!!document.getElementById('register-error')`, 30000);
		lost.error = await p.evaluate(`document.getElementById('register-error').textContent.trim()`);
		lost.typed = await typedValues();
		await A.start();
		lost.dbBeforeRetry = dbRows().rows.filter((r) => JSON.parse(r.fields).filing === 'Synthetic lost filing').length;
		await p.click('#register-add');
		await p.waitFor(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].some((r) => r.textContent.includes('Synthetic lost filing'))`, 20000);
		lost.retryRows = dbRows().rows.filter((r) => JSON.parse(r.fields).filing === 'Synthetic lost filing').length;

		// restarts: graceful, then SIGKILL; every saved row (by id and fields) and the shown register are unchanged
		const beforeRestart = { db: dbRows(), shown: await reg() };
		const graceful = await A.stop();
		await A.start();
		await p.goto(`${V}/evidence/filings_tab`, R('filings_tab'));
		const afterGraceful = { db: dbRows(), shown: await reg() };
		await A.srv.proc.kill('SIGKILL');
		await sleep(300);
		A.srv = null;
		await A.start();
		await p.goto(`${V}/evidence/filings_tab`, R('filings_tab'));
		const afterKill = { db: dbRows(), shown: await reg() };

		// the register export: imported values unchanged, a user-entered formula neutralised
		await fill({ fl_filing: '=1+2' });
		await p.click('#register-add');
		await p.waitFor(`document.querySelectorAll('#filing-register tbody tr[data-key]').length === ${afterKill.shown.length + 1}`, 15000);
		await p.click('#export-register');
		await p.waitFor('window.__dl.length > 0', 15000);
		const [dl] = await takeDownloads();
		const csv = dl.text.split('\r\n');

		const want = (o) => Object.values(o);
		const checks = {
			nav: nav.ok, disclosure: disclosure === 'unverified', seeds: seeds0.length === 2 && seeds0.every((s) => s.state === 'seed' && s.key.startsWith('seed:')),
			added: added.length === 3 && added.at(-1).cells[0] === 'Synthetic added filing' && added.at(-1).cells[5] === 'OD-002 ↗' && added.at(-1).state === 'user' && Object.values(formReset).every((v) => v === ''),
			edited: edited.length === 2 && edited[0].key === s1.key && edited[0].state === 'edited' && edited[0].cells[3] === 'Synthetic seed reply edited' && edited[1].key === userKey && edited[1].cells[0] === 'Synthetic edited filing',
			reloaded: J(reloaded) === J(edited),
			storage: db1.rows.length === 1 && db1.overlays.length === 2 && seedsKept === 2 && db1.overlays.some((o) => JSON.parse(o.fields).deleted === true),
			busyError: /could not be saved: the local store is busy/.test(busy.error) && J(Object.values(busy.typed)) === J(want(busyEntry)) && busy.rowsDuring === 2 && busy.heldMs >= 12000 && busy.dbAfterRelease === 1 && busy.retryRows === 1,
			lostError: /could not be saved: the app did not answer/.test(lost.error) && J(Object.values(lost.typed)) === J(want(lostEntry)) && lost.dbBeforeRetry === 0 && lost.retryRows === 1,
			gracefulRestart: graceful.graceful === true && J(afterGraceful.db) === J(beforeRestart.db) && J(afterGraceful.shown) === J(beforeRestart.shown),
			killRestart: J(afterKill.db) === J(beforeRestart.db) && J(afterKill.shown) === J(beforeRestart.shown),
			export: dl.name === 'filing-register.csv' && csv[0] === 'filing,fdate,fparty,response,rdate,ref,status' && csv.at(-1).startsWith("'=1+2,") && csv.length === afterKill.shown.length + 2,
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, seeds0, added, edited, reloaded, db1, busy, lost, graceful, beforeRestart: beforeRestart.shown, afterGraceful: afterGraceful.shown, afterKill: afterKill.shown, csvHead: csv[0], csvLast: csv.at(-1) } };
	});

	// E10 (diff): compare two known texts as an explicit pair, with coverage
	await scenario('E-DIFF', 'hoa_diff_tab', 'Document Diff: an explicitly chosen pair of known texts gives the literal word diff, states the compared coverage (BA-06, BA-08), survives reload; one document only asks for two; documents beyond v5s pick-list limit are offered', async () => {
		const nav = await viaNav('hoa_diff_tab', 'Document Diff');
		const options = await p.evaluate(`[...document.getElementById('diffA').options].map((o) => o.value).filter(Boolean)`);
		const choose = async (a, bb, mode = 'words') => {
			await p.evaluate(`(() => { for (const [id, v] of [['diffA', ${J(a)}], ['diffB', ${J(bb)}], ['diffmode', ${J(mode)}]]) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
			await p.click('#diff-run');
			await p.waitFor(`document.getElementById('main').dataset.result !== 'none' && ${R('hoa_diff_tab')}`, 15000);
		};
		await choose('VDM-901', 'VDM-902');
		const read = () => p.evaluate(`({ head: document.querySelector('#diffOut h3')?.textContent.trim() ?? null, segs: [...(document.getElementById('diff-body')?.childNodes ?? [])].filter((n) => n.nodeType === 3 || n.nodeType === 1).map((n) => (n.nodeType === 3 ? 'eq' : n.classList.contains('diffdel') ? 'del' : n.classList.contains('diffadd') ? 'add' : '?') + ':' + n.textContent).filter((s) => !s.endsWith(':')), coverage: document.getElementById('diff-pair-coverage')?.textContent.replace(/\\s+/g, ' ').trim() ?? null, url: location.search })`);
		const pair = await read();
		await p.goto(`${V}/evidence/hoa_diff_tab${pair.url}`, R('hoa_diff_tab'));
		const reloaded = await read();
		await choose('VDM-901', '');
		const pick = await p.evaluate(`document.querySelector('#diffOut .empty')?.textContent.trim() ?? null`);
		const general = await p.evaluate(`document.getElementById('diff-coverage')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
		const withExcerpt = chronology.filter((x) => x.excerpt).map((x) => x.ref);
		const checks = {
			nav: nav.ok, options: J(options) === J(withExcerpt) && !options.includes('VDM-903'),
			literal: pair.head === 'VDM-901 vs VDM-902' && J(pair.segs) === J(['eq:the ', 'del:cat', 'add:dog', 'eq: sat']),
			coverage: pair.coverage === 'Compared text: the excerpt of VDM-901 (11 characters, text extracted) and of VDM-902 (11 characters, text extracted), not the full documents.',
			explicitPair: /You choose the two documents; they are compared because you chose them, not because they are known versions of each other\./.test(general ?? ''),
			reload: J(reloaded.segs) === J(pair.segs) && reloaded.head === pair.head, pick: pick === 'Pick two documents.',
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, pair, reloaded, pick, general, optionsN: options.length } };
	});
	exitOk = true;
} catch (e) {
	scenarios.push({ id: 'HARNESS', view: 'none', title: 'evidence suite harness', pass: false, evidence: { error: String(e?.stack ?? e).slice(0, 4000) } });
	console.log(`FAIL    HARNESS ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
	const st = await A.stop().catch((e) => ({ error: String(e) }));
	await b?.close().catch(() => {});
	rmSync(tmp, { recursive: true, force: true });
	if (st && st.graceful === false) scenarios.push({ id: 'STOP', view: 'none', title: 'the server stops gracefully on SIGTERM', pass: false, evidence: st });
}
process.exit(finish({ completed: exitOk }) ? 0 : 1);
