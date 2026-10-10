// App adapter: CaseLines (GRS-19). The shared extractor reads the page; the add-documents list takes v5's id. Sweeps
// mirror scripts/parity/adapters/v5/specs/caselines_tab.mjs: search through the page's own box (the server searches
// the page-text index), go to a page and open a result, each of which opens the document page at that page.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { fromRaw, remap } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';
import { runSweeps } from '../v5/specs/caselines_tab.mjs';

const VIEW = 'caselines_tab';
const where = (p) => p.evaluate(`(() => { if (!/\\/doc\\//.test(location.pathname)) return 'none'; const n = new URLSearchParams(location.search).get('page'); return n ? 'page=' + n : 'open'; })()`);
// data-ready is server-rendered; controls work once the page has hydrated
const openView = async (p, ctx) => { await open(p, ctx, ctx.registry[VIEW].route, VIEW); await p.waitFor(`document.querySelector('main[data-hydrated]')`, 60000); };
const APP = {
	fresh: openView,
	search: async (p, q) => {
		await p.type('#cl-q', q);
		await p.click('#cl-go');
		await p.waitFor(`document.getElementById('cl-results')?.dataset.q === ${JSON.stringify(q.trim())}`, 30000);
		await sleep(40);
	},
	gotoPage: async (p, n) => { await p.type('#cl-pg', n); await p.click('#cl-goto'); await sleep(400); return where(p); },
	clickHit: async (p) => { await p.click('#cl-results .cl-hit'); await sleep(400); return where(p); },
};

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openView(p, ctx);
		const s = remap(fromRaw(VIEW, 'app', await p.extract('#main')), { 'list.add_documents_to_caselines': 'list_1' });
		if (ctx.exports !== false) {
			// v5's Download is a plain file link (no Blob), so pressing it captures nothing; the app's leads to the document page
			await p.takeDownloads();
			const got = await p.evaluate(`document.getElementById('cl-download') ? 1 : 0`);
			if (got) { await p.click('#cl-download'); await sleep(300); }
			s.exports.download = (await p.takeDownloads()).length ? { name: 'captured' } : { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: runSweeps(APP),
};
