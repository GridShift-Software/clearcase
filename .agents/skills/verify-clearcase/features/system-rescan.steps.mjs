// Drive steps of features/system-rescan.md (GRS-20): a quick scan of the unchanged synthetic folder, one addition
// found twice with one ref, and the overview's Freshness card counting it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const must = (cond, msg) => { if (!cond) throw new Error(msg); };
async function scan(x) {
	await x.page.evaluate(`(() => { window.__busySeen = false; const o = new MutationObserver(() => { if (document.getElementById('scan-busy')) { window.__busySeen = true; o.disconnect(); } }); o.observe(document.body, { childList: true, subtree: true }); return true; })()`);
	const t0 = Date.now();
	await x.click('#rescan-now');
	const t1 = Date.now();
	await x.page.waitFor(`window.__busySeen && !document.getElementById('scan-busy') && !!document.getElementById('count-new')`, 30000);
	return x.page.evaluate(`({ added: document.getElementById('count-new').textContent, scanned: document.getElementById('count-scanned').textContent, current: document.getElementById('rescan-status').dataset.current, refs: [...document.querySelectorAll('#rescan-added tr[data-ref]')].map((r) => r.dataset.ref), verdict: document.getElementById('rescan-verdict')?.textContent.trim() })`).then((r) => ({ ...r, clickMs: t1 - t0, ms: Date.now() - t0 }));
}

export const steps = [
	{
		id: 'system-rescan', feature: 'system-rescan', title: 'Rescan & Update: an unchanged folder adds nothing; one new file gets one ref that a repeat scan keeps',
		async run(x) {
			// the viewer step leaves the PDF tab in front; a hidden tab gets no frames, so screenshots and navigations stall
			await x.b.send('Page.bringToFront', {}, x.page.sessionId);
			await x.click('#nav-rescan_tab');
			await x.waitReady('rescan_tab');
			const unchanged = await scan(x);
			must(unchanged.added === '0' && unchanged.scanned === '7' && unchanged.current === 'false', `unchanged ${JSON.stringify(unchanged)}`);
			mkdirSync(join(x.synth.caseDir, 'DISCOVERY A'), { recursive: true });
			writeFileSync(join(x.synth.caseDir, 'DISCOVERY A', 'OD-009 Added letter.pdf'), '%PDF-1.4\n% synthetic addition\n%%EOF\n');
			const first = await scan(x);
			const second = await scan(x);
			must(JSON.stringify(first.refs) === '["OD-005"]' && JSON.stringify(second.refs) === '["OD-005"]' && second.added === '1', `additions ${JSON.stringify({ first, second })}`);
			return { unchanged, first, second, shot: await x.shot('system-rescan-added') };
		},
	},
	{
		id: 'system-freshness', feature: 'system-rescan', title: 'Overview Freshness card: the build stamp counts the addition and links to Rescan & Update',
		async run(x) {
			await x.click('#nav-overview');
			await x.waitReady('overview');
			const r = await x.page.evaluate(`({ status: document.querySelector('section[data-slot="rescan-freshness"]')?.dataset.slotStatus, stamp: document.getElementById('freshness-stamp')?.textContent.trim(), scan: document.getElementById('freshness-scan')?.textContent.replace(/\\s+/g, ' ').trim(), link: document.querySelector('#freshness-scan a')?.getAttribute('href') })`);
			must(r.status === 'filled' && / · 8 documents indexed · \+1 via rescan\.$/.test(r.stamp ?? '') && /quick scan/.test(r.scan ?? '') && /\/system\/rescan_tab$/.test(r.link ?? ''), `freshness ${JSON.stringify(r)}`);
			return { ...r, shot: await x.shot('system-freshness') };
		},
	},
];
