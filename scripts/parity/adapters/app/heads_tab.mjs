// App adapter: Heads of Argument (GRS-18). The generic extraction over #main, the Export capture, and v5's
// register_edit sweep through the app's own form; the submission the sweep leaves is deleted again before the
// overview is read (v5 starts each sweep with empty storage).
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { deleteRowsWith, openHydrated, registerEdit } from '../../../../tests/e2e/litigation/lib/parity.mjs';
import { navFocus, open, pressAndCapture } from './_shell.mjs';

const VIEW = 'heads_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) s.exports.export = (await pressAndCapture(p, '#heads-export', parseDownload))?.[0] ?? { name: '(nothing captured)' };
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		register_edit: (p, ctx) => registerEdit(p, ctx, VIEW, { cleanup: (pg) => deleteRowsWith(pg, 'Synthetic entry') }),
	},
};
