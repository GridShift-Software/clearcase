#!/usr/bin/env bun
// Lane 02 probe (synthetic case only): record a payment larger than the imported gross claim, then open
// Settlement / BATNA with no query (a plain visit) and read what the model shows. Run under offline.sh.
const W = '/home/vaper/Work/Active/MX-two/ClearCase/worktrees/verify-CC-06-02';
const { mkdtempSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { launch, newPage, sleep } = await import(`${W}/tests/e2e/pilot/lib/cdp.mjs`);
const { client, vpath } = await import(`${W}/tests/e2e/pilot/lib/client.mjs`);
const { CAPTURE, J, pageKit, quantumCase, ready, server } = await import(`${W}/tests/e2e/quantum/lib.mjs`);
const tmp = mkdtempSync(join('/home/vaper/.cache/cc06-v02', 'probe-run-'));
const S = server({ root: W, buildDir: join(W, 'build'), port: 43620, dir: tmp });
let b, rc = 1;
try {
	const sc = await quantumCase(join(tmp, 'case'));
	await S.start();
	const c = client(S.port);
	const imp = await c.importPkg(sc.caseDir, sc.pkgDir);
	await c.activate(imp.importId, { ack: true });
	const base = `${S.origin}${vpath(sc.resultsVersion)}`;
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const p = await newPage(b, { initScript: CAPTURE });
	const k = pageKit(p, base);
	await k.open('/quantum/settlement_tab', 'settlement_tab');
	const before = { claim: await k.value('#se_claim'), kpis: (await k.kpis('#se_out')).length, error: await k.text('#se-error') };
	await k.open('/quantum/payments_tab', 'payments_tab');
	await k.fill([['#pay_date', '2094-02-01'], ['#pay_amount', '2 000'], ['#pay_method', 'Synthetic'], ['#pay_note', 'Synthetic overpayment']]);
	await k.click('#pay-add');
	await p.waitFor(`document.querySelectorAll('#payments tbody tr[data-row-id]').length === 1`, 20000);
	const net = await k.kpi('Net claim');
	await k.open('/quantum/settlement_tab', 'settlement_tab');
	const after = { claim: await k.value('#se_claim'), kpis: (await k.kpis('#se_out')).length, error: await k.text('#se-error'), note: await k.text('#se-net') };
	await k.click('#se-reset');
	await sleep(500);
	const reset = { claim: await k.value('#se_claim'), kpis: (await k.kpis('#se_out')).length, error: await k.text('#se-error') };
	console.log(J({ before, net, after, reset }, null, 1));
	rc = 0;
} catch (e) { console.error(e); } finally { try { await b?.close?.(); } catch {} await S.stop(); rmSync(tmp, { recursive: true, force: true }); }
process.exit(rc);
