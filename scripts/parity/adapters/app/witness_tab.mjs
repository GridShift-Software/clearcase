// App adapter: Witnesses (GRS-15). Read-only table; the generic extraction reads it as v5's is read.
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'witness_tab';

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
};
