#!/usr/bin/env bun
// Lane 02 probe (synthetic case only): the quantum suite's case plus one invoice-ledger row whose ref is not a
// document (ZZ-404). Reads the prescription doc-cell hrefs and the ledger's link/broken cells. Run under offline.sh.
const W = '/home/operator/Work/Active/MX-two/ClearCase/worktrees/verify-CC-06-02';
const { mkdtempSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { launch, newPage } = await import(`${W}/tests/e2e/pilot/lib/cdp.mjs`);
const { client, vpath } = await import(`${W}/tests/e2e/pilot/lib/client.mjs`);
const { buildCase } = await import(`${W}/tests/e2e/pilot/lib/fixtures.ts`);
const { CAPTURE, J, pageKit, quantumCase, server } = await import(`${W}/tests/e2e/quantum/lib.mjs`);
const tmp = mkdtempSync(join('/home/operator/.cache/cc06-v02', 'probe-run-'));
const S = server({ root: W, buildDir: join(W, 'build'), port: 43630, dir: tmp });
let b, rc = 1;
try {
	// reuse the suite's edits, then add the unknown ref (buildCase is what quantumCase calls)
	const sc = await buildCase(join(tmp, 'case'), { caseId: 'e2e-quantum-probe', edit: (r) => {
		const D = r.DATA;
		D.quantum.invoiceLedger = [
			{ amount: '1.00', bundle: 'Original', date: '2081-01-31', no: 'SYNINV1', ref: 'OD-002', text_status: 'extracted', url: './DISCOVERY%20A/elsewhere.pdf' },
			{ amount: '2.00', bundle: 'Original', date: '2081-02-28', no: 'SYNINV9', ref: 'ZZ-404', text_status: 'none', url: './nowhere.pdf' },
		];
		D.lit.prescription = [{ no: 'SYNP1', ref: 'OD-001', date: '2088-02-29', prescDate: '2091-02-28', risk: 'Relies on interruption', url: './DISCOVERY%20A/elsewhere.pdf' }];
	} });
	await S.start();
	const c = client(S.port);
	const imp = await c.importPkg(sc.caseDir, sc.pkgDir);
	await c.activate(imp.importId, { ack: true });
	const base = `${S.origin}${vpath(sc.resultsVersion)}`;
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const p = await newPage(b, { initScript: CAPTURE });
	const k = pageKit(p, base);
	await k.open('/quantum/prescription_tab', 'prescription_tab');
	const presc = await p.evaluate(`[...document.querySelectorAll('#prescription tbody tr')].map((r) => { const a = r.cells[6].querySelector('a'); return a ? ['link', a.textContent.trim(), a.getAttribute('href')] : ['text', r.cells[6].textContent.trim()]; })`);
	await k.open('/quantum/invoice_ledger_tab', 'invoice_ledger_tab');
	const ledger = await p.evaluate(`[...document.querySelectorAll('#main table tbody tr')].map((r) => { const cell = r.cells[r.cells.length - 1]; const a = cell.querySelector('a'); return a ? ['link', a.textContent.trim(), a.getAttribute('href')] : [cell.querySelector('.cite-broken') ? 'broken' : 'text', cell.textContent.trim()]; })`);
	console.log(J({ docPathPrefix: vpath(sc.resultsVersion), presc, ledger }, null, 1));
	rc = 0;
} catch (e) { console.error(e); } finally { try { await b?.close?.(); } catch {} await S.stop(); rmSync(tmp, { recursive: true, force: true }); }
process.exit(rc);
