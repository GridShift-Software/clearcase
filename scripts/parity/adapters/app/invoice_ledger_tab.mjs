// App adapter: Invoice Ledger (GRS-16, CC-06). The page keeps v5's layout: the gross-invoiced KPI, the ledger table and the
// export. The shared extractor reads it under v5's ids; the export
// is captured from the app's own button.
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open, pressAndCapture } from './_shell.mjs';

/** Open one of this view's routes and wait until it is hydrated (data-ready is server-rendered; data-hydrated marks working controls). */
const openView = async (p, ctx, route, view) => { await open(p, ctx, route, view); await p.waitFor(`!!document.querySelector('main[data-ready="${view}"][data-hydrated]')`, 30000); };

const VIEW = 'invoice_ledger_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openView(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) {
			const got = await pressAndCapture(p, '#export-invoices', parseDownload);
			s.exports.export_csv = got?.[0] ?? { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
