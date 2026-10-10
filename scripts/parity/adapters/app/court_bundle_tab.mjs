// App adapter: Court Bundle (GRS-19). The list view keeps v5's structure (KPI cards, header card, bundles table,
// narrative card), so the shared extractor reads both sides alike. Sweeps mirror
// scripts/parity/adapters/v5/specs/court_bundle_tab.mjs: the Word indexes and one bundle's Index and Items tabs.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';
import { runSweeps } from '../v5/specs/court_bundle_tab.mjs';

const VIEW = 'court_bundle_tab';
const at = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;
// data-ready is server-rendered; controls work once the page has hydrated
const openView = async (p, ctx) => { await open(p, ctx, ctx.registry[VIEW].route, VIEW); await p.waitFor(`document.querySelector('main[data-hydrated]')`, 60000); };
const APP = {
	fresh: openView,
	wordAll: (p) => p.click('#cb-word-all'),
	openFirst: async (p) => { await p.click('#cb-list tbody tr:first-child button'); await p.waitFor(at('#cb-index'), 30000); await sleep(40); },
	wordOne: (p) => p.click('#cb-word'),
	itemsTab: async (p) => { await p.click('#cb-tab-items'); await p.waitFor(at('#cb-items'), 30000); await sleep(40); },
	title: (p) => p.evaluate(`document.getElementById('cb-bundle-h')?.textContent.trim() ?? ''`),
	sub: (p) => p.evaluate(`(document.getElementById('cb-bundle-sub')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`),
	indexHead: '#cbindexdoc > p',
	indexRows: '#cbindexdoc table.cbixt tr',
	itemsRows: '#cb-items tbody tr',
};

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openView(p, ctx);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: runSweeps(APP),
};
