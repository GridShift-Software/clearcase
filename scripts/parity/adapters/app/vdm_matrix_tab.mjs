// App adapter: Defence & Rebuttal (GRS-15). The generic extraction reads the matrix; the Export CSV control is pressed
// and its download parsed, as on the v5 side.
import { parseDownload } from '../../lib/exports.mjs';
import { readSimpleView, pressAndCapture } from './_shell.mjs';

const VIEW = 'vdm_matrix_tab';
/** The server-rendered page is ready to read at once; wait for hydration before clicking its controls. */
const hydrated = (p) => p.waitFor(`document.querySelector('main#main[data-hydrated]') !== null`, 30000);

export default {
	view: VIEW,
	async extract(p, ctx) {
		const s = await readSimpleView(p, ctx, VIEW, { hydrate: hydrated });
		if (ctx.exports) {
			const got = await pressAndCapture(p, '#export-csv', parseDownload);
			s.exports.export_csv = got?.[0] ?? { name: '(nothing captured)' };
		}
		return s;
	},
};
