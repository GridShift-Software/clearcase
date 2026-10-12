// App adapter: Authorities (GRS-18). The generic extraction over #main, the Export CSV capture, and v5's
// register_edit sweep through the app's own form. Authorities have no Delete in v5 or the app (S-authorities_tab-1,
// copied), so the sweep cannot remove the two rows it adds: register_edit is this view's last (and only) sweep, and
// nothing in the run reads this view after it.
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { openHydrated, registerEdit } from '../../../../tests/e2e/litigation/lib/parity.mjs';
import { navFocus, open, pressAndCapture } from './_shell.mjs';

const VIEW = 'authorities_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) s.exports.export_csv = (await pressAndCapture(p, '#auth-export', parseDownload))?.[0] ?? { name: '(nothing captured)' };
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		register_edit: (p, ctx) => registerEdit(p, ctx, VIEW),
	},
};
