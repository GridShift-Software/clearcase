// App adapter: Defence & Rebuttal (GRS-15). The generic extraction reads the matrix; the Export CSV control is pressed
// and its download parsed, as on the v5 side.
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open, pressAndCapture } from './_shell.mjs';

const VIEW = 'vdm_matrix_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) {
			const got = await pressAndCapture(p, '#export-csv', parseDownload);
			s.exports.export_csv = got?.[0] ?? { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
