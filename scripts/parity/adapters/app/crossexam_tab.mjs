// App adapter: Cross-Exam Prep (GRS-18). The generic extraction over #main; v5's register sweep through the app's
// own form. v5's sweep deletes the first shown row, an imported seed: the app records that as a seed overlay
// {deleted: true} (no overlay-delete API exists in this wave), so both sides end without that seed, as v5's storage
// does. The two synthetic topics the sweep adds are user rows and are deleted again before the overview is read.
import { fromRaw } from '../../lib/snapshot.mjs';
import { deleteRowsWith, registerEdit } from '../../../../tests/e2e/litigation/lib/parity.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'crossexam_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		register_edit: (p, ctx) => registerEdit(p, ctx, VIEW, { cleanup: (pg) => deleteRowsWith(pg, 'Synthetic entry') }),
	},
};
