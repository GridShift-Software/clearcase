// App adapter: Manual (GRS-20). Reached from the overview through the sidebar like v5's tab; the page is read as
// rendered (texts, controls, tables) and compared with v5's snapshot ids.
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';

export default {
	view: 'manual',
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: 'manual' });
		await open(p, ctx, ctx.registry['manual'].route, 'manual');
		const s = fromRaw('manual', 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
