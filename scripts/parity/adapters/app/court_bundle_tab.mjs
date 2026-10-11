// App adapter: Court Bundle (GRS-19). The list view keeps v5's structure (KPI cards, header card, bundles table,
// narrative card), so the shared extractor reads both sides alike. Sweeps mirror
// scripts/parity/adapters/v5/specs/court_bundle_tab.mjs: the Word indexes and one bundle's Index and Items tabs.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';
import { openRow, runSweeps, until } from '../v5/specs/court_bundle_tab.mjs';

const VIEW = 'court_bundle_tab';
const at = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;
// data-ready is server-rendered; controls work once the page has hydrated
const openView = async (p, ctx) => { await open(p, ctx, ctx.registry[VIEW].route, VIEW); await p.waitFor(`document.querySelector('main[data-hydrated]')`, 60000); };
const LIST = '#cb-list tbody tr';
const APP = {
	bld: {
		open: async (p, ctx) => { await openView(p, ctx); await p.click('#cb-build'); await p.waitFor(at('#cbbfile'), 30000); },
		back: async (p) => { await p.evaluate('history.back()'); await until(p, at('#cbbname')); await sleep(100); },
		toList: async (p) => { await p.click('#cb-builder-back'); await until(p, at('#cb-list')); await sleep(100); },
		fromList: async (p) => { await p.click('#cb-build'); await until(p, at('#cbbname')); },
		leave: `document.getElementById('nav-overview').click();`,
		reload: openView,
		openRow: async (p, no) => { await openRow(p, LIST, no); await until(p, at('#cb-index')); },
		listRows: LIST,
		/** The saved bundles go again, so the case store is as the run found it. */
		cleanup: async (p, ctx) => {
			await openView(p, ctx);
			await p.evaluate('window.confirm = () => true');
			for (let n = await p.evaluate(`document.querySelectorAll('[data-delete]').length`), k = 0; n > 0 && k < 10; k++) {
				await p.click('[data-delete]');
				await until(p, `document.querySelectorAll('[data-delete]').length < ${n}`, 15000);
				n = await p.evaluate(`document.querySelectorAll('[data-delete]').length`);
			}
		},
	},
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
