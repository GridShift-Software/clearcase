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
// D4: two rows whose bundle has an empty name (the schema allows any string)
const NO_BUNDLE = ['NB-001', 'NB-002'];
for (const ref of NO_BUNDLE) {
	const file = `NOBUNDLE/${ref} Synthetic.txt`;
	originals[file] = enc(`Synthetic unbundled ${ref}\n`);
	extra.push(row(ref, 400 + extra.length, file, originals[file].byteLength, { bundle: '', doc_type: 'other', subject: `Synthetic unbundled ${ref}` }));
}
for (const [ref, excerpt, type, date] of ADD) {
	const file = `ADDITIONAL/${ref} Synthetic.txt`;
	originals[file] = enc(`Synthetic additional ${ref}\n`);
	extra.push(row(ref, 300 + extra.length, file, originals[file].byteLength, { bundle: 'Additional', doc_type: type, date, excerpt, subject: `Synthetic additional ${ref}` }));
}
let chronology, peopleData, entityData;
const tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-evidence-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const sc = await buildCase(join(tmp, 'case-src'), {
	caseId: 'e2e-evidence', originals, rows: extra,
	edit: (r) => {
		r.DATA.filings.registerSeed.push({ fdate: '', filing: 'Synthetic second seed', fparty: 'Respondent', rdate: '', ref: 'EM-0001', response: 'Synthetic reply', status: '' });
		r.DATA.people.push({ name: 'Synthetic Mailer', email: 'no-reply@example.invalid', org: 'Synthetic Attorneys Inc', sent: 9, received: 0, total: 9, role: '' });
		r.DATA.people.push({ name: 'Synthetic Counsel', email: 'counsel@example.invalid', org: 'Org B', sent: 1, received: 1, total: 2, role: 'attorney' });
		chronology = r.DATA.chronology.map((x) => ({ ...x }));
		peopleData = r.DATA.people.map((x) => ({ ...x }));
		entityData = r.DATA.entities.map((x) => ({ ...x }));
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
const R = (view) => `document.querySelector('main#main')?.dataset.ready === ${J(view)} && (${J(view)} === 'overview' || document.querySelector('main#main')?.dataset.hydrated === '1') && !document.querySelector('main#main')?.dataset.busy`;
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
	// D18: the evidence views read their data through SvelteKit's page data (__data.json); each change must load one
	// page of rows, never the whole list. Each payload since a mark is fetched again and its row objects counted.
	const pageData = (m) => p.evaluate(`Promise.all(${J(reqsSince(m).filter((u) => u.includes('__data.json')))}.map(async (u) => { const t = await (await fetch(u)).text(); return { bytes: t.length, rows: (t.match(/"ref":/g) || []).length }; }))`);
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
	await scenario('E-DOCS', 'documents', 'Documents: every imported bundle selectable (Additional included), filter resets to page 1, Next keeps bundle and filter in the URL, type-then-date order, Back from a document keeps the state, each change loads one page of rows as page data (D18)', async () => {
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
		const data = await pageData(m);
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
			additionalAll, onePagePerChange: data.length >= 3 && data.every((d) => d.rows <= 60), backKeepsState: before.url === after.url && J(before.rows) === J(after.rows) && after.filter === 'synthetic' && /bundle=Additional/.test(after.url),
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, buttons, page1Len: page1.length, page2Len: page2.length, filtered, additional, pageData: data.map(({ bytes, rows }) => ({ bytes, rows })), before, after } };
	});

	// E1-E6 (search): literal synthetic results, bundle and type, pagination keeps the query, export order, BA-15, BA-08
	await scenario('E-SEARCH', 'search', 'Advanced Search: literal results, bundle + type filter (Additional), the query kept across pagination, export order = page order (BA-17), reversed date and amount intervals rejected apart from a genuine empty result (BA-15), coverage counted from the rows (BA-08), each search loads one page of results as page data (D18), a refused search keeps its input', async () => {
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
		const reversedAmountKept = await p.evaluate(`({ amin: document.getElementById('samin').value, amax: document.getElementById('samax').value })`);
		const notNumber = await submit({ samin: 'abc' });
		const genuineEmpty = await submit({ sf: '1990-01-01', sto: '1990-01-02' });
		const data = await pageData(m);
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
			onePagePerChange: data.length >= 7 && data.every((d) => d.rows <= 50),
			refusalKeepsInput: J(reversedAmountKept) === J({ amin: '10', amax: '1' }),
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, cov, expectCov, bulk: { n: bulk.refs.length, count: bulk.count }, page2, exportedN: exported.length, additionalReport: additionalReport.refs, reversedDate, reversedAmount, reversedAmountKept, notNumber, genuineEmpty, pageData: data.map(({ bytes, rows }) => ({ bytes, rows })) } };
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
	await scenario('E-ENTITIES', 'entity_ledger_tab', "Entities: the unverified-role disclosure (BA-07); an organisation read from the People table is an entity with its imported role", async () => {
		// the person and organisation come from the People table as shown, the role from the imported entities
		await p.goto(`${V}/evidence/people`, R('people'));
		const orgs = await p.evaluate(`[...document.querySelectorAll('#people-table tbody tr')].map((r) => r.cells[2]?.textContent.trim() ?? '').filter(Boolean)`);
		const person = { org: orgs.find((o) => entityData.some((e) => e.name === o)) ?? null };
		const imported = entityData.find((e) => e.name === person.org) ?? null;
		const nav = await viaNav('entity_ledger_tab', 'Entities');
		const t = await p.evaluate(`({ rows: [...document.querySelectorAll('#entities-table tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim())), disclosure: document.getElementById('identity-status')?.dataset.verification ?? null })`);
		const checks = { nav: nav.ok, disclosure: t.disclosure === 'unverified', personOrg: !!person.org && !!imported?.role, relationship: !!imported && t.rows.some((r) => r[0] === person.org && r[1] === imported.role) };
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, nav: nav.got, orgs, person, rows: t.rows } };
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
		await p.click(`#filing-register tr[data-key=${J(userKey)}] [data-edit]`);
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
		await p.click(`#filing-register tr[data-key=${J(s2.key)}] [data-delete]`);
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

	// ---- CC-04 r2 (D1, D2): unsaved register input survives failed, busy and other rows' actions --------------------
	const regRows = () => p.evaluate(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].map((r) => ({ key: r.dataset.key, filing: r.cells[0]?.querySelector('b')?.textContent ?? '' }))`);
	const setFields = async (pg, v, events = true) => { for (const [id, x] of Object.entries(v)) await pg.evaluate(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(x)}; ${events ? `e.dispatchEvent(new Event('input', { bubbles: true }));` : ''} return true; })()`); };
	const formOf = (pg) => pg.evaluate(`({ mode: document.getElementById('register-form')?.dataset.mode ?? null, key: document.querySelector('#register-form input[name=key]')?.value ?? null, values: Object.fromEntries(['fl_filing', 'fl_fdate', 'fl_fparty', 'fl_response', 'fl_rdate', 'fl_ref'].map((id) => [id, document.getElementById(id)?.value ?? null])), saveError: document.getElementById('register-error')?.querySelector('p')?.textContent.trim() ?? document.getElementById('register-error')?.textContent.trim() ?? null, retry: !!document.getElementById('register-retry'), discard: !!document.getElementById('register-discard'), cancel: !!document.getElementById('register-cancel'), deleteError: document.getElementById('register-delete-error')?.querySelector('p')?.textContent.trim() ?? null, held: !!document.getElementById('register-held'), editsDisabled: [...document.querySelectorAll('#filing-register [data-edit]')].map((b) => b.disabled) })`);
	const inFlight = (pg) => pg.evaluate(`({ status: document.getElementById('register-status')?.textContent.trim() ?? null, fieldset: document.querySelector('#register-form fieldset')?.disabled ?? null, ariaBusy: document.getElementById('register-form')?.getAttribute('aria-busy') ?? null, edits: [...document.querySelectorAll('#filing-register [data-edit]')].every((b) => b.disabled), deletes: [...document.querySelectorAll('#filing-register [data-delete], #filing-register .actions form[action*=delete] button')].every((b) => b.disabled) })`);
	const holdStore = () => { const l = new Database(join(A.dataDir, 'work.sqlite')); l.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); const at = Date.now(); return () => { try { l.exec('ROLLBACK'); } finally { l.close(); } return Date.now() - at; }; };
	const storedFilings = () => A.work(`SELECT row_id, fields FROM register_row WHERE store = 'filings-register' ORDER BY row_id`).map((r) => ({ id: r.row_id, filing: JSON.parse(r.fields).filing, response: JSON.parse(r.fields).response }));
	const deleteOf = (key) => `#filing-register tr[data-key=${J(key)}] [data-delete], #filing-register tr[data-key=${J(key)}] .actions form[action*=delete] button`;
	const editOf = (key) => `#filing-register tr[data-key=${J(key)}] [data-edit], #filing-register tr[data-key=${J(key)}] .actions form:first-child button`;
	const errorShown = `!!document.getElementById('register-error') || !!document.getElementById('register-delete-error')`;
	let draftKeys = [];
	await scenario('E-FILINGS-DRAFTS', 'filings_tab', 'Filings with JavaScript (CC-04 r2 D1, D2): a busy Delete of another row keeps the edit in progress and shows its own error; a busy Delete after a failed Add keeps both errors and the draft, and Retry adds one row; the form is inert with a visible status in flight, so a completed save never wipes text typed meanwhile; an Edit pressed during a failing save never receives its failure; Edit and the sidebar ask before dropping a failed draft; a later save of the same row from a second tab is refused, not an overwrite', async () => {
		await p.goto(`${V}/evidence/filings_tab`, R('filings_tab'));
		for (const name of ['Synthetic draft row A', 'Synthetic draft row B', 'Synthetic draft row C']) {
			const n = (await regRows()).length;
			await setFields(p, { fl_filing: name });
			await p.click('#register-add');
			await p.waitFor(`document.querySelectorAll('#filing-register tbody tr[data-key]').length === ${n + 1} && !document.getElementById('register-status')`, 20000);
		}
		const keyOf = async (name) => (await regRows()).find((r) => r.filing === name)?.key;
		const [kA, kB, kC] = [await keyOf('Synthetic draft row A'), await keyOf('Synthetic draft row B'), await keyOf('Synthetic draft row C')];
		draftKeys = [kA, kB, kC];
		const ev = { keys: draftKeys };

		// D1: an edit in progress, then a busy Delete of another row
		await p.goto(`${V}/evidence/filings_tab?edit=${encodeURIComponent(kA)}`, `${R('filings_tab')} && document.getElementById('register-form').dataset.mode === 'edit'`);
		await p.type('#fl_filing', 'Unsaved edited filing');
		await p.type('#fl_response', 'Unsaved edited reply');
		let release = holdStore();
		try {
			await p.click(deleteOf(kB));
			await sleep(400);
			ev.d1InFlight = await inFlight(p);
			await p.waitFor(errorShown, 30000).catch(() => null);
			await sleep(200);
			ev.d1 = await formOf(p);
		} finally { ev.d1HeldMs = release(); }
		ev.d1RowKept = (await regRows()).some((r) => r.key === kB);
		await p.click('#register-save');
		await p.waitFor(`document.getElementById('register-form')?.dataset.mode === 'add' && [...document.querySelectorAll('#filing-register tbody tr[data-key]')].some((r) => r.textContent.includes('Unsaved edited filing'))`, 20000).catch(() => null);
		ev.d1Saved = storedFilings().filter((r) => r.filing === 'Unsaved edited filing' && r.response === 'Unsaved edited reply').length;
		// a delete error stays until it is dismissed (or that row's delete succeeds); a save never clears it
		ev.d1ErrorAfterSave = await p.evaluate(`!!document.getElementById('register-delete-error')`);
		await p.click('#register-delete-dismiss').catch(() => {});

		// D2: a failed Add, then a busy Delete: both errors stay, apart, with the draft; Retry adds one row
		await setFields(p, { fl_filing: 'Synthetic failed add', fl_response: 'Synthetic failed add reply' });
		release = holdStore();
		try {
			await p.click('#register-add');
			await p.waitFor(`!!document.getElementById('register-error')`, 30000).catch(() => null);
			ev.addFailed = await formOf(p);
			await p.click(deleteOf(kB));
			await p.waitFor(`!document.getElementById('register-status') && (!!document.getElementById('register-delete-error') || !document.getElementById('register-error'))`, 30000).catch(() => null);
			await sleep(200);
			ev.both = await formOf(p);
		} finally { release(); }
		await p.click('#register-retry').catch(() => p.click('#register-add'));
		await p.waitFor(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].some((r) => r.textContent.includes('Synthetic failed add')) && !document.getElementById('register-status')`, 20000).catch(() => null);
		ev.afterRetry = { ...(await formOf(p)), stored: storedFilings().filter((r) => r.filing === 'Synthetic failed add').length };
		if (ev.afterRetry.deleteError) await p.click('#register-delete-dismiss').catch(() => {});

		// D2: a save in flight: the form and every row action are inert with a status; the completed save resets the form
		await setFields(p, { fl_filing: 'Synthetic in-flight add' });
		release = holdStore();
		try {
			await p.click('#register-add');
			await sleep(400);
			await p.type('#fl_response', 'typed in flight').catch(() => {});
			ev.addInFlight = { ...(await inFlight(p)), response: await p.evaluate(`document.getElementById('fl_response').value`) };
			await sleep(1200);
		} finally { ev.inFlightHeldMs = release(); }
		await p.waitFor(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].some((r) => r.textContent.includes('Synthetic in-flight add')) && !document.getElementById('register-status')`, 20000).catch(() => null);
		ev.afterInFlight = { ...(await formOf(p)), stored: storedFilings().filter((r) => r.filing === 'Synthetic in-flight add').length };

		// D2: Edit of row C pressed while row A's save is failing; the failure stays with A's draft
		await p.goto(`${V}/evidence/filings_tab?edit=${encodeURIComponent(kA)}`, `${R('filings_tab')} && document.getElementById('register-form').dataset.mode === 'edit'`);
		await p.type('#fl_filing', 'Synthetic failed edit A');
		release = holdStore();
		try {
			await p.click('#register-save');
			await sleep(400);
			await p.click(editOf(kC)).catch(() => {});
			await p.waitFor(`!!document.getElementById('register-error')`, 30000).catch(() => null);
			await sleep(300);
			ev.editDuring = await formOf(p);
		} finally { release(); }
		// Edit of another row and the sidebar ask before dropping the failed draft; Keep it keeps everything
		await p.click(editOf(kC)).catch(() => {});
		ev.askEdit = await p.waitFor(`document.getElementById('register-ask')?.textContent.includes('was not saved')`, 5000).then(() => true, () => false);
		await p.click('#register-ask-keep').catch(() => {});
		await sleep(300);
		await p.click('#nav-documents');
		ev.askNav = await p.waitFor(`document.getElementById('register-ask')?.textContent.includes('was not saved')`, 5000).then(() => true, () => false);
		await p.click('#register-ask-keep').catch(() => {});
		await sleep(300);
		ev.afterKeep = { ...(await formOf(p)), path: await p.evaluate('location.pathname + location.search') };
		await p.click('#register-retry').catch(() => {});
		await p.waitFor(`document.getElementById('register-form')?.dataset.mode === 'add' && [...document.querySelectorAll('#filing-register tbody tr[data-key]')].some((r) => r.textContent.includes('Synthetic failed edit A'))`, 20000).catch(() => null);
		ev.afterEditRetry = { ...(await formOf(p)), storedA: storedFilings().filter((r) => r.filing === 'Synthetic failed edit A').length };

		// two tabs edit one row: the later save from the older version is refused with its input kept, never an overwrite
		await p.goto(`${V}/evidence/filings_tab?edit=${encodeURIComponent(kA)}`, `${R('filings_tab')} && document.getElementById('register-form').dataset.mode === 'edit'`);
		const other = await openPage(b, { initScript: INIT });
		try {
			await other.goto(`${V}/evidence/filings_tab?edit=${encodeURIComponent(kA)}`, `${R('filings_tab')} && document.getElementById('register-form').dataset.mode === 'edit'`);
			await other.type('#fl_response', 'Saved in the other tab');
			await other.click('#register-save');
			await other.waitFor(`document.getElementById('register-form')?.dataset.mode === 'add'`, 20000).catch(() => null);
		} finally { await other.close().catch(() => {}); }
		await p.type('#fl_response', 'Saved in this tab later');
		await p.click('#register-save');
		await p.waitFor(`!!document.getElementById('register-error') || document.getElementById('register-form')?.dataset.mode === 'add'`, 20000).catch(() => null);
		await sleep(300);
		ev.twoTabs = { ...(await formOf(p)), shown: await p.evaluate(`document.querySelector(${J(`#filing-register tr[data-key="${kA}"]`)})?.cells[3]?.textContent.trim() ?? null`), stored: storedFilings().find((r) => `row:${r.id}` === kA)?.response ?? null };
		await p.click('#register-discard').catch(() => {});
		await p.waitFor(`document.getElementById('register-form')?.dataset.mode === 'add' && !document.getElementById('register-error')`, 10000).catch(() => null);

		const blankForm = (f) => Object.values(f.values).every((v) => v === '');
		const checks = {
			d1InFlightBusyShown: ev.d1InFlight.status === 'Deleting the entry…' && ev.d1InFlight.fieldset === true && ev.d1InFlight.edits && ev.d1InFlight.deletes,
			d1EditKept: ev.d1.mode === 'edit' && ev.d1.key === kA && ev.d1.values.fl_filing === 'Unsaved edited filing' && ev.d1.values.fl_response === 'Unsaved edited reply',
			d1OwnError: /^The entry could not be deleted: the local store is busy/.test(ev.d1.deleteError ?? '') && ev.d1.saveError === null && ev.d1RowKept && ev.d1HeldMs >= 9000,
			d1SavedAfter: ev.d1Saved === 1 && ev.d1ErrorAfterSave === true,
			addFailureRetry: /could not be saved: the local store is busy/.test(ev.addFailed.saveError ?? '') && ev.addFailed.retry && ev.addFailed.values.fl_filing === 'Synthetic failed add',
			deleteKeepsSaveFailure: /could not be saved/.test(ev.both.saveError ?? '') && /could not be deleted/.test(ev.both.deleteError ?? '') && ev.both.values.fl_filing === 'Synthetic failed add' && ev.both.values.fl_response === 'Synthetic failed add reply' && ev.both.retry,
			retryAddsOne: ev.afterRetry.stored === 1 && ev.afterRetry.saveError === null && blankForm(ev.afterRetry) && /could not be deleted/.test(ev.afterRetry.deleteError ?? ''),
			inertInFlight: ev.addInFlight.status === 'Adding the entry…' && ev.addInFlight.fieldset === true && ev.addInFlight.ariaBusy === 'true' && ev.addInFlight.edits && ev.addInFlight.deletes && !ev.addInFlight.response.includes('typed in flight'),
			completedSaveResets: ev.afterInFlight.stored === 1 && blankForm(ev.afterInFlight) && ev.inFlightHeldMs >= 1500 && ev.inFlightHeldMs < 4000,
			failureStaysWithItsRow: ev.editDuring.mode === 'edit' && ev.editDuring.key === kA && ev.editDuring.values.fl_filing === 'Synthetic failed edit A' && /could not be saved/.test(ev.editDuring.saveError ?? ''),
			asksBeforeDropping: ev.askEdit && ev.askNav && ev.afterKeep.key === kA && ev.afterKeep.values.fl_filing === 'Synthetic failed edit A' && /could not be saved/.test(ev.afterKeep.saveError ?? '') && !ev.afterKeep.cancel && ev.afterKeep.discard && ev.afterKeep.path.endsWith('/evidence/filings_tab?edit=' + encodeURIComponent(kA)),
			retrySavesTheEdit: ev.afterEditRetry.storedA === 1 && ev.afterEditRetry.mode === 'add',
			twoTabsNoOverwrite: /changed elsewhere/.test(ev.twoTabs.saveError ?? '') && ev.twoTabs.values.fl_response === 'Saved in this tab later' && ev.twoTabs.stored === 'Saved in the other tab' && ev.twoTabs.shown === 'Saved in the other tab',
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, ...ev } };
	});

	await scenario('E-FILINGS-NOJS', 'filings_tab', 'Filings without JavaScript (CC-04 r2 D1, D2): a busy Delete of another row keeps the edit in progress; a refused save of an edit comes back in edit mode with its values, Retry and Discard, and the rows Edit buttons wait with a note; a Delete after it keeps the draft and its failure; Retry saves the edit once; a refused Search keeps what was typed', async () => {
		const q = await openPage(b, { initScript: INIT });
		await q.s('Emulation.setScriptExecutionDisabled', { value: true });
		const ev = {};
		try {
			const open = async (url, view = 'filings_tab') => { const r = await q.navigate(url); if (r.errorText) throw new Error(r.errorText); await q.waitFor(`document.querySelector('main#main')?.dataset.ready === ${J(view)}`, 20000); };
			const post = async (sel, view = 'filings_tab') => { const mk = await q.evaluate('(window.__mk = Math.random())'); await q.click(sel); await q.waitFor(`window.__mk !== ${mk} && document.querySelector('main#main')?.dataset.ready === ${J(view)}`, 40000).catch(() => null); await sleep(200); };
			const [kA, kB, kC] = draftKeys;
			ev.keys = draftKeys;
			// D1 without JavaScript: an edit in progress, then a busy Delete of another row
			await open(`${V}/evidence/filings_tab?edit=${encodeURIComponent(kA)}`);
			ev.hydrated = await q.evaluate(`!!document.querySelector('main#main')?.dataset.hydrated`);
			await setFields(q, { fl_filing: 'No-JS edited filing', fl_response: 'No-JS edited reply' }, false);
			let release = holdStore();
			try { await post(deleteOf(kC)); } finally { release(); }
			ev.d1 = { ...(await formOf(q)), rowKept: (await q.evaluate(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].map((r) => r.dataset.key)`)).includes(kC) };
			// a refused save of the edit comes back in edit mode
			release = holdStore();
			try { await post('#register-save'); } finally { release(); }
			ev.saveFailed = await formOf(q);
			// a Delete of another row (done) keeps the draft and its failure
			await post(deleteOf(kC));
			ev.afterDelete = { ...(await formOf(q)), rows: await q.evaluate(`[...document.querySelectorAll('#filing-register tbody tr[data-key]')].map((r) => r.dataset.key)`) };
			const before = storedFilings().length;
			await post('#register-retry');
			ev.afterRetry = { ...(await formOf(q)), stored: storedFilings().filter((r) => r.filing === 'No-JS edited filing' && r.response === 'No-JS edited reply').length, storedDelta: storedFilings().length - before, url: await q.evaluate('location.pathname + location.search') };
			// GET form: a refused search keeps what was typed
			await open(`${V}/evidence/search`, 'search');
			await setFields(q, { sq: 'Synthetic', samin: '10', samax: '1' }, false);
			await post('#search-run', 'search');
			ev.search = await q.evaluate(`({ result: document.getElementById('main').dataset.result, invalid: document.getElementById('search-invalid')?.textContent.trim() ?? null, q: document.getElementById('sq').value, amin: document.getElementById('samin').value, amax: document.getElementById('samax').value })`);
		} finally { await q.close().catch(() => {}); }
		const [kA, , kC] = draftKeys;
		const editVals = (f) => f.values.fl_filing === 'No-JS edited filing' && f.values.fl_response === 'No-JS edited reply';
		const checks = {
			noScripts: ev.hydrated === false,
			d1EditKept: ev.d1.mode === 'edit' && ev.d1.key === kA && editVals(ev.d1) && /could not be deleted/.test(ev.d1.deleteError ?? '') && ev.d1.saveError === null && ev.d1.rowKept,
			refusedEditStaysEdit: ev.saveFailed.mode === 'edit' && ev.saveFailed.key === kA && editVals(ev.saveFailed) && /could not be saved: the local store is busy/.test(ev.saveFailed.saveError ?? '') && ev.saveFailed.retry && ev.saveFailed.discard && !ev.saveFailed.cancel,
			editsWaitWithNote: ev.saveFailed.held && ev.saveFailed.editsDisabled.length > 0 && ev.saveFailed.editsDisabled.every(Boolean),
			deleteKeepsDraftAndFailure: !ev.afterDelete.rows.includes(kC) && ev.afterDelete.mode === 'edit' && ev.afterDelete.key === kA && editVals(ev.afterDelete) && /could not be saved/.test(ev.afterDelete.saveError ?? '') && ev.afterDelete.retry && ev.afterDelete.deleteError === null,
			retrySavesOnce: ev.afterRetry.stored === 1 && ev.afterRetry.storedDelta === 0 && ev.afterRetry.mode === 'add' && ev.afterRetry.saveError === null && !ev.afterRetry.url.includes('?'),
			searchRefusalKeepsInput: ev.search.result === 'invalid' && /Amount min is greater than Amount max/.test(ev.search.invalid ?? '') && ev.search.q === 'Synthetic' && ev.search.amin === '10' && ev.search.amax === '1',
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, ...ev } };
	});

	// ---- CC-04 r2 (D3, D4): URL values the controls cannot show, and the empty-named bundle --------------------------
	await scenario('E-URLSTATE', 'search', 'Search and Documents (CC-04 r2 D3, D4): an unknown bundle option and a malformed date are refused on the Search page and by its export, never as an empty result; Documents names a page it does not show; the empty-named bundle is selectable as "(no bundle)" in Documents and Search', async () => {
		const ev = {};
		const S = `${V}/evidence/search`;
		const readSearch = () => p.evaluate(`({ result: document.getElementById('main').dataset.result, invalid: document.getElementById('search-invalid')?.textContent.trim() ?? null, empty: !!document.getElementById('search-empty'), refs: [...document.querySelectorAll('#search-table tbody tr[data-ref]')].map((r) => r.dataset.ref) })`);
		await p.goto(`${S}?q=&bundle=NoSuchSyntheticBundle`, R('search'));
		ev.unknownOption = await readSearch();
		await p.goto(`${S}?q=&from=abc`, R('search'));
		ev.badDate = await readSearch();
		ev.export = await p.evaluate(`Promise.all([${J(`${S}/export?q=&bundle=NoSuchSyntheticBundle`)}, ${J(`${S}/export?q=&from=abc`)}, ${J(`${S}/export?q=&from=2091-02-30`)}, ${J(`${S}/export?q=synthetic`)}].map(async (u) => { const r = await fetch(u); return { status: r.status, text: (await r.text()).slice(0, 160) }; }))`);
		await p.goto(`${V}/evidence/documents?page=abc`, R('documents'));
		ev.docPage = await p.evaluate(`({ notice: document.getElementById('page-notice')?.textContent.trim() ?? null, page: document.getElementById('main').dataset.page })`);
		// D4: Documents selects the empty-named bundle by its own value
		await p.goto(`${V}/evidence/documents`, R('documents'));
		ev.docButton = await p.evaluate(`document.querySelector('#main .toolbar button[data-bundle="~"]')?.textContent.trim() ?? null`);
		await p.click('#main .toolbar button[data-bundle="~"]');
		await p.waitFor(`document.getElementById('main').dataset.bundle === '' && ${R('documents')}`, 15000).catch(() => null);
		ev.docEmpty = await p.evaluate(`({ url: location.search, bundle: document.getElementById('main').dataset.bundle, refs: [...document.querySelectorAll('#documents-table tbody tr[data-ref]')].map((r) => r.dataset.ref), unknown: !!document.getElementById('unknown-bundle') })`);
		// D4: Search offers it as its own option, not as All
		await p.goto(S, R('search'));
		ev.options = await p.evaluate(`[...document.getElementById('sb').options].map((o) => [o.value, o.textContent.trim()])`);
		await p.evaluate(`(() => { const e = document.getElementById('sb'); e.value = '~'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
		await p.click('#search-run');
		await p.waitFor(`document.getElementById('main').dataset.result !== 'idle' && ${R('search')}`, 15000).catch(() => null);
		ev.searchEmpty = { ...(await readSearch()), url: await p.evaluate('location.search'), selected: await p.evaluate(`document.getElementById('sb').value`) };
		const checks = {
			unknownOption: ev.unknownOption.result === 'invalid' && /Bundle “NoSuchSyntheticBundle” is not in this results version\./.test(ev.unknownOption.invalid ?? '') && !ev.unknownOption.empty,
			badDate: ev.badDate.result === 'invalid' && /From date “abc” is not a date \(YYYY-MM-DD\)\./.test(ev.badDate.invalid ?? '') && !ev.badDate.empty,
			exportRefuses: ev.export[0].status === 400 && /Bundle/.test(ev.export[0].text) && ev.export[1].status === 400 && /not a date/.test(ev.export[1].text) && ev.export[2].status === 400 && /calendar/.test(ev.export[2].text) && ev.export[3].status === 200,
			documentsPageNotice: ev.docPage.notice === 'The requested page “abc” is not a page number; page 1 is shown.' && ev.docPage.page === '1',
			documentsEmptyBundle: ev.docButton === `(no bundle) (${NO_BUNDLE.length})` && /(^|[?&])bundle=(~|%7E)(&|$)/.test(ev.docEmpty.url) && ev.docEmpty.bundle === '' && J(ev.docEmpty.refs) === J(NO_BUNDLE) && !ev.docEmpty.unknown,
			searchEmptyBundle: ev.options.some(([v, l]) => v === '~' && l === '(no bundle)') && ev.options.filter(([v]) => v === '').length === 1 && ev.searchEmpty.result === 'results' && J(ev.searchEmpty.refs) === J(NO_BUNDLE) && ev.searchEmpty.selected === '~',
		};
		return { pass: Object.values(checks).every(Boolean), evidence: { checks, ...ev } };
	});

	// E10 (diff): compare two known texts as an explicit pair, with coverage
	await scenario('E-DIFF', 'hoa_diff_tab', 'Document Diff: an explicitly chosen pair of known texts gives the literal word diff, states the compared coverage (BA-06, BA-08), survives reload; one document only asks for two; every document with an excerpt is offered', async () => {
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
